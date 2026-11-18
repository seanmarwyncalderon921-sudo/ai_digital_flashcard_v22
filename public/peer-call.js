(function installPeerCall() {
  "use strict";

  const FALLBACK_ICE_SERVERS = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
  ];
  const $ = id => document.getElementById(id);
  function newCallId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function createPeerCall({ conversationId, peerName, signaling, getIceServers }) {
    if (!conversationId || !signaling || typeof signaling.send !== "function") {
      throw new TypeError("A conversation and signaling connection are required.");
    }

    let disposed = false;
    let callId = "";
    let role = "";
    let localStream = null;
    let peerConnection = null;
    let transport = signaling;
    let incomingTimer = null;
    let dismissTimer = null;
    let connectionTimer = null;
    let pendingCandidates = [];
    let isMuted = false;
    let cameraOff = false;
    let starting = false;
    let accepting = false;
    const listenerController = new AbortController();
    const modal = $("peer-call-modal");
    const localVideo = $("peer-call-local");
    const remoteVideo = $("peer-call-remote");
    const status = $("peer-call-status");
    const incomingActions = $("peer-call-incoming-actions");
    const activeActions = $("peer-call-active-actions");

    function setStatus(message) {
      if (status) status.textContent = message;
    }

    function show({ incoming = false } = {}) {
      modal?.classList.remove("hidden");
      incomingActions?.classList.toggle("hidden", !incoming);
      activeActions?.classList.toggle("hidden", incoming || !localStream);
      const title = $("peer-call-title");
      if (title) title.textContent = `Video call${peerName ? ` · ${peerName}` : ""}`;
    }

    function stopLocalMedia() {
      if (localStream) localStream.getTracks().forEach(track => track.stop());
      localStream = null;
      if (localVideo) localVideo.srcObject = null;
      if (remoteVideo) remoteVideo.srcObject = null;
    }

    function closePeerConnection() {
      if (!peerConnection) return;
      peerConnection.onicecandidate = null;
      peerConnection.ontrack = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
      peerConnection = null;
    }

    function reset({ hide = true } = {}) {
      clearTimeout(incomingTimer);
      clearTimeout(dismissTimer);
      clearTimeout(connectionTimer);
      incomingTimer = null;
      dismissTimer = null;
      connectionTimer = null;
      closePeerConnection();
      stopLocalMedia();
      pendingCandidates = [];
      callId = "";
      role = "";
      isMuted = false;
      cameraOff = false;
      const muteButton = $("peer-call-mute");
      const cameraButton = $("peer-call-camera");
      if (muteButton) muteButton.textContent = "Mute mic";
      if (cameraButton) cameraButton.textContent = "Turn camera off";
      if (incomingActions) incomingActions.classList.add("hidden");
      if (activeActions) activeActions.classList.add("hidden");
      if (hide) modal?.classList.add("hidden");
    }

    async function acquireMedia() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Video calls require a secure HTTPS connection and a supported browser.");
      }
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: "user" } });
      if (localVideo) {
        localVideo.srcObject = localStream;
        localVideo.play().catch(() => {});
      }
    }

    async function resolvedIceServers() {
      try {
        const servers = await getIceServers?.();
        if (Array.isArray(servers) && servers.some(server => server?.urls)) return [...servers, ...FALLBACK_ICE_SERVERS];
      } catch (error) {
        console.warn("Using fallback STUN servers:", error?.message || error);
      }
      return FALLBACK_ICE_SERVERS;
    }

    async function makePeerConnection() {
      if (peerConnection) return peerConnection;
      if (!window.RTCPeerConnection) throw new Error("This browser does not support WebRTC video calls.");
      peerConnection = new RTCPeerConnection({ iceServers: await resolvedIceServers() });
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
      peerConnection.onicecandidate = event => {
        if (event.candidate && transport && callId) {
          transport.send("ice", callId, event.candidate.toJSON());
        }
      };
      peerConnection.ontrack = event => {
        if (!remoteVideo) return;
        if (event.streams?.[0]) remoteVideo.srcObject = event.streams[0];
        else {
          const stream = remoteVideo.srcObject || new MediaStream();
          stream.addTrack(event.track);
          remoteVideo.srcObject = stream;
        }
        remoteVideo.play().catch(() => {});
      };
      peerConnection.onconnectionstatechange = () => {
        if (disposed || !peerConnection) return;
        if (peerConnection.connectionState === "connected") { clearTimeout(connectionTimer); connectionTimer = null; setStatus("Connected"); }
        if (peerConnection.connectionState === "disconnected") {
          setStatus("Connection interrupted. Trying to reconnect…");
          clearTimeout(connectionTimer);
          connectionTimer = setTimeout(() => {
            if (peerConnection?.connectionState === "disconnected") finish("Connection lost", false);
          }, 15000);
        }
        if (peerConnection.connectionState === "failed") {
          setStatus("Could not connect. This network may require a TURN relay.");
          dismissTimer = setTimeout(() => reset(), 2500);
        }
      };
      return peerConnection;
    }

    async function flushCandidates() {
      if (!peerConnection?.remoteDescription) return;
      const candidates = pendingCandidates;
      pendingCandidates = [];
      for (const candidate of candidates) await peerConnection.addIceCandidate(candidate);
    }

    async function handleSignal(event) {
      if (disposed) return;
      if (event.type === "disconnect") {
        if (callId) { reset(); setStatus("Call ended because the connection was lost."); }
        return;
      }
      if (event.userId === window.sapcFirebase?.getCurrentUser()?.uid) return;
      if (event.type === "invite") {
        if (callId) {
          transport.send("decline", event.callId);
          return;
        }
        callId = event.callId;
        role = "callee";
        show({ incoming: true });
        setStatus(`${peerName || "Your friend"} is calling…`);
        incomingTimer = setTimeout(() => finish("missed", false), 45_000);
        return;
      }
      if (!callId || event.callId !== callId) return;
      if (event.type === "decline") { setStatus("Call declined"); dismissTimer = setTimeout(() => reset(), 1200); return; }
      if (event.type === "hangup") { setStatus("Call ended"); dismissTimer = setTimeout(() => reset(), 900); return; }
      if (event.type === "accept" && role === "caller") {
        try {
          const pc = await makePeerConnection();
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          transport.send("offer", callId, pc.localDescription.toJSON());
          setStatus("Calling…");
        } catch (error) { fail(error); }
        return;
      }
      try {
        if (event.type === "offer" && role === "callee") {
          const pc = await makePeerConnection();
          await pc.setRemoteDescription(event.data);
          await flushCandidates();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          transport.send("answer", callId, pc.localDescription.toJSON());
          setStatus("Connecting…");
        } else if (event.type === "answer" && role === "caller") {
          await peerConnection.setRemoteDescription(event.data);
          await flushCandidates();
          setStatus("Connecting…");
        } else if (event.type === "ice") {
          const candidate = new RTCIceCandidate(event.data);
          if (!peerConnection?.remoteDescription) pendingCandidates.push(candidate);
          else await peerConnection.addIceCandidate(candidate);
        }
      } catch (error) { fail(error); }
    }

    function fail(error) {
      console.error("Video call error:", error);
      if (callId && transport) transport.send(role === "callee" ? "decline" : "hangup", callId);
      show();
      setStatus(error?.name === "NotAllowedError"
        ? "Camera or microphone permission was denied. Check your browser permissions."
        : error?.message || "The call could not be started.");
      incomingTimer = setTimeout(() => reset(), 3500);
    }

    function finish(message = "Call ended", notify = true) {
      const currentCallId = callId;
      if (notify && currentCallId && transport) transport.send("hangup", currentCallId);
      reset();
      if (message && status) status.textContent = message;
    }

    async function start() {
      if (disposed || callId || starting) return;
      if (!window.isSecureContext) return fail(new Error("Video calls require HTTPS."));
      if (!window.RTCPeerConnection) return fail(new Error("This browser does not support WebRTC video calls."));
      starting = true;
      try {
        await acquireMedia();
        if (disposed) return reset();
        role = "caller";
        callId = newCallId();
        show();
        setStatus("Ringing… Keep this chat open while calling.");
        transport.send("invite", callId);
        incomingTimer = setTimeout(() => finish("No answer", true), 45_000);
      } catch (error) { if (!disposed) fail(error); }
      finally { starting = false; }
    }

    async function accept() {
      if (disposed || !callId || role !== "callee" || accepting) return;
      accepting = true;
      clearTimeout(incomingTimer);
      incomingTimer = null;
      try {
        if (!window.isSecureContext) throw new Error("Video calls require HTTPS.");
        await acquireMedia();
        if (disposed || !callId) return reset();
        show();
        setStatus("Joining call…");
        transport.send("accept", callId);
      } catch (error) { if (!disposed) fail(error); }
      finally { accepting = false; }
    }

    function decline() {
      if (callId) transport.send("decline", callId);
      reset();
    }

    const listenerOptions = { signal: listenerController.signal };
    $("peer-call-accept")?.addEventListener("click", accept, listenerOptions);
    $("peer-call-decline")?.addEventListener("click", decline, listenerOptions);
    $("peer-call-end")?.addEventListener("click", () => finish(), listenerOptions);
    $("peer-call-mute")?.addEventListener("click", event => {
      isMuted = !isMuted;
      localStream?.getAudioTracks().forEach(track => { track.enabled = !isMuted; });
      event.currentTarget.textContent = isMuted ? "Unmute mic" : "Mute mic";
    }, listenerOptions);
    $("peer-call-camera")?.addEventListener("click", event => {
      cameraOff = !cameraOff;
      localStream?.getVideoTracks().forEach(track => { track.enabled = !cameraOff; });
      event.currentTarget.textContent = cameraOff ? "Turn camera on" : "Turn camera off";
    }, listenerOptions);
    window.addEventListener("pagehide", () => finish("Call ended"), listenerOptions);
    return {
      start,
      handleSignal,
      isBusy: () => Boolean(callId),
      dispose() {
        if (disposed) return;
        disposed = true;
        listenerController.abort();
        if (callId && transport) transport.send("hangup", callId);
        signaling.unsubscribe?.();
        reset();
      }
    };
  }

  window.SapcPeerCall = { createPeerCall };
})();
