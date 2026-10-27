"use strict";

/* Janela escondida do ditado. Só o microfone. Não mostra texto e não rouba o foco. */
(function () {
  const bridge = window.dictation;
  let rec = null;
  let chunks = [];
  let stream = null;

  function stopTracks() {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  async function start() {
    stopTracks();
    chunks = [];
    try {
      stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      bridge.failed();
      return;
    }
    const mime = window.MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    rec = new window.MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    rec.start();
  }

  function stop() {
    if (!rec) {
      bridge.failed();
      return;
    }
    const current = rec;
    rec = null;
    current.onstop = async () => {
      const blob = new Blob(chunks, { type: current.mimeType || "audio/webm" });
      chunks = [];
      stopTracks();
      try {
        bridge.audio(await blob.arrayBuffer(), blob.type);
      } catch {
        bridge.failed();
      }
    };
    try {
      current.stop();
    } catch {
      bridge.failed();
    }
  }

  bridge.onStart(start);
  bridge.onStop(stop);
})();
