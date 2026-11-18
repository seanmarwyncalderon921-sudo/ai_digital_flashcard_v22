import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config();

const required = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "SUPABASE_URL", "SUPABASE_SECRET_KEY"];
const missing = required.filter(key => !process.env[key]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
  })
});

const firestore = admin.firestore();
const supabaseUrl = process.env.SUPABASE_URL.replace(/\/+$/, "");
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

function clean(value) {
  if (value == null) return value;
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(clean);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
  return value;
}

async function upsert(table, items, conflict) {
  // Postgres rejects a single upsert statement if its input contains the same
  // conflict key more than once. Direct-message conversations can share a
  // canonical id when legacy Firestore contains duplicate conversation docs.
  const rows = conflict
    ? [...new Map(items.map(item => [String(item[conflict]), item])).values()]
    : items;
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    if (!batch.length) continue;
    const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
    if (conflict) url.searchParams.set("on_conflict", conflict);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(batch)
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Import to ${table} failed (${response.status}): ${detail}`);
    }
  }
}

const privateProfiles = await firestore.collection("users").get();
const publicProfiles = await firestore.collection("publicProfiles").get();
const profilesById = new Map();
for (const doc of privateProfiles.docs) profilesById.set(doc.id, { user_id: doc.id, ...clean(doc.data()) });
for (const doc of publicProfiles.docs) profilesById.set(doc.id, { ...(profilesById.get(doc.id) || { user_id: doc.id }), ...clean(doc.data()) });

const profiles = [...profilesById].map(([uid, data]) => {
  const displayName = String(data.displayName || data.username || data.email?.split("@")[0] || "Paduan").slice(0, 80);
  const username = String(data.username || "").trim().toLowerCase().slice(0, 24);
  return {
    user_id: uid,
    email: String(data.email || ""),
    display_name: displayName,
    display_name_lower: String(data.displayNameLower || displayName.toLowerCase()),
    username,
    username_lower: String(data.usernameLower || username),
    bio: String(data.bio || "").slice(0, 300),
    photo_url: String(data.photoURL || ""),
    grade_level: String(data.gradeLevel || "").slice(0, 30),
    strand: String(data.strand || "").slice(0, 50),
    created_at: data.createdAt || new Date().toISOString(),
    updated_at: data.updatedAt || new Date().toISOString(),
    last_seen_at: data.lastSeenAt || null
  };
});
await upsert("profiles", profiles, "user_id");
console.log(`Imported ${profiles.length} profiles.`);

const decks = [];
const sessions = [];
for (const userDoc of privateProfiles.docs) {
  const [deckSnapshot, sessionSnapshot] = await Promise.all([
    userDoc.ref.collection("decks").get(),
    userDoc.ref.collection("studySessions").get()
  ]);
  for (const doc of deckSnapshot.docs) {
    const data = clean(doc.data());
    decks.push({
      id: doc.id,
      owner_id: userDoc.id,
      title: String(data.title || "Saved Reviewer Deck").slice(0, 120),
      subject_mode: String(data.subjectMode || "general").slice(0, 30),
      grade_level: String(data.gradeLevel || "Grade 11").slice(0, 40),
      academic_strand: String(data.academicStrand || "General").slice(0, 80),
      tags: Array.isArray(data.tags) ? data.tags : [],
      cards: Array.isArray(data.cards) ? data.cards : [],
      created_at: data.createdAt || new Date().toISOString(),
      updated_at: data.updatedAt || new Date().toISOString()
    });
  }
  for (const doc of sessionSnapshot.docs) {
    const data = clean(doc.data());
    sessions.push({
      id: doc.id,
      owner_id: userDoc.id,
      deck_id: String(data.deckId || "local-session"),
      correct: Number(data.correct) || 0,
      total: Number(data.total) || 0,
      duration_seconds: Number(data.durationSeconds) || 0,
      completed_at: data.completedAt || new Date().toISOString()
    });
  }
}
await upsert("decks", decks, "id");
await upsert("study_sessions", sessions, "id");
console.log(`Imported ${decks.length} decks and ${sessions.length} study sessions.`);

const sharesSnapshot = await firestore.collection("sharedDecks").get();
const shares = sharesSnapshot.docs.map(doc => {
  const data = clean(doc.data());
  return {
    id: doc.id,
    owner_id: String(data.ownerId || ""),
    title: String(data.title || "Shared Reviewer Deck").slice(0, 120),
    subject_mode: String(data.subjectMode || "general").slice(0, 30),
    cards: Array.isArray(data.cards) ? data.cards : [],
    created_at: data.createdAt || new Date().toISOString()
  };
}).filter(row => row.owner_id && profilesById.has(row.owner_id));
await upsert("shared_decks", shares, "id");
console.log(`Imported ${shares.length} shared decks.`);

const friendSnapshot = await firestore.collection("friendRequests").get();
const friendRequests = friendSnapshot.docs.map(doc => {
  const data = clean(doc.data());
  return {
    id: doc.id,
    from_id: String(data.fromId || ""),
    to_id: String(data.toId || ""),
    from_name: String(data.fromName || "Paduan").slice(0, 80),
    to_name: String(data.toName || "Paduan").slice(0, 80),
    status: ["pending", "accepted", "rejected"].includes(data.status) ? data.status : "pending",
    created_at: data.createdAt || new Date().toISOString(),
    updated_at: data.updatedAt || data.createdAt || new Date().toISOString()
  };
}).filter(row => row.from_id && row.to_id && profilesById.has(row.from_id) && profilesById.has(row.to_id));
await upsert("friend_requests", friendRequests, "id");
console.log(`Imported ${friendRequests.length} friend requests.`);

const conversationSnapshot = await firestore.collection("chatConversations").get();
const conversations = [];
const messages = [];
for (const doc of conversationSnapshot.docs) {
  const data = clean(doc.data());
  const participants = Array.isArray(data.participants) ? data.participants.map(String) : [];
  if (!participants.length) continue;
  const createdBy = String(data.createdBy || participants[0]);
  if (!profilesById.has(createdBy)) continue;
  const conversationId = data.type === "group" || participants.length !== 2
    ? doc.id
    : `chat:${[...participants].sort().join(":")}`;
  conversations.push({
    id: conversationId,
    type: data.type === "group" ? "group" : "direct",
    title: String(data.title || "").slice(0, 60),
    created_by: createdBy,
    participants,
    members: Array.isArray(data.members) ? data.members : [],
    created_at: data.createdAt || new Date().toISOString(),
    updated_at: data.updatedAt || new Date().toISOString()
  });
  const messageSnapshot = await doc.ref.collection("messages").orderBy("timestamp", "asc").get();
  for (const messageDoc of messageSnapshot.docs) {
    const message = clean(messageDoc.data());
    const senderId = String(message.senderId || "");
    if (!senderId || !profilesById.has(senderId)) continue;
    const attachments = Array.isArray(message.attachments) ? message.attachments : (message.attachment ? [message.attachment] : []);
    messages.push({
      id: messageDoc.id,
      conversation_id: conversationId,
      sender_id: senderId,
      text: String(message.text || ""),
      ciphertext: message.ciphertext || null,
      iv: message.iv || null,
      is_unsent: Boolean(message.isUnsent),
      attachments,
      reply_to: message.replyTo || null,
      seen_by: message.seenBy || {},
      timestamp: message.timestamp || new Date().toISOString(),
      updated_at: message.updatedAt || message.timestamp || new Date().toISOString()
    });
  }
}
await upsert("chat_conversations", conversations, "id");
await upsert("chat_messages", messages, "id");
console.log(`Imported ${conversations.length} conversations and ${messages.length} messages.`);
console.log("Firestore export is complete. Existing Firestore data was not modified.");
