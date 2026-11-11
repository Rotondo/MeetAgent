(function exposeAudioCapture() {
  async function getSystemStream() {
    await window.agent.enableLoopbackAudio();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      for (const track of stream.getVideoTracks()) {
        track.stop();
        stream.removeTrack(track);
      }
      if (!stream.getAudioTracks().length) throw new Error('nenhum áudio do sistema foi selecionado');
      return stream;
    } finally {
      await window.agent.disableLoopbackAudio().catch(() => {});
    }
  }

  function getMicrophoneStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  }

  async function start({ mode = 'both', onChunk, onMicrophoneChunk, onLevel, onSourceStatus }) {
    const wantsSystem = mode === 'both' || mode === 'system';
    const wantsMic = mode === 'both' || mode === 'microphone';
    const streams = [];
    const failures = [];

    if (wantsSystem) {
      try {
        streams.push({ kind: 'system', stream: await getSystemStream() });
        onSourceStatus?.('system', true);
      } catch (err) {
        failures.push(`sistema: ${err.message}`);
        onSourceStatus?.('system', false);
      }
    }
    if (wantsMic) {
      try {
        streams.push({ kind: 'microphone', stream: await getMicrophoneStream() });
        onSourceStatus?.('microphone', true);
      } catch (err) {
        failures.push(`microfone: ${err.message}`);
        onSourceStatus?.('microphone', false);
      }
    }
    if (!streams.length) throw new Error(`captura indisponível (${failures.join('; ')})`);

    let stopped = false;
    for (const { kind, stream } of streams) {
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (!stopped) onSourceStatus?.(kind, false);
        }, { once: true });
      }
    }

    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('pcm-worklet.js');
      const mixer = ctx.createGain();
      mixer.gain.value = streams.length > 1 ? 0.5 : 1;
      const sources = streams.map(({ kind, stream }) => {
        const source = ctx.createMediaStreamSource(stream);
        source.connect(mixer);
        return { kind, source };
      });
      const worklet = new AudioWorkletNode(ctx, 'pcm16-processor', {
        processorOptions: { targetSampleRate: 16000, chunkSamples: 1600 },
      });
      const mute = ctx.createGain();
      mute.gain.value = 0;
      mixer.connect(worklet);
      worklet.connect(mute).connect(ctx.destination);
      worklet.port.onmessage = ({ data }) => {
        if (data.type === 'chunk') onChunk?.(data.buffer);
        if (data.type === 'level') onLevel?.(data.value);
      };
      const micSource = sources.find((item) => item.kind === 'microphone')?.source;
      let micWorklet = null;
      if (micSource && onMicrophoneChunk) {
        micWorklet = new AudioWorkletNode(ctx, 'pcm16-processor', {
          processorOptions: { targetSampleRate: 16000, chunkSamples: 1600 },
        });
        micSource.connect(micWorklet);
        micWorklet.port.onmessage = ({ data }) => {
          if (data.type === 'chunk') onMicrophoneChunk(data.buffer);
        };
      }
      await ctx.resume();
      ctx.addEventListener('statechange', () => {
        if (!stopped && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
          for (const { kind } of streams) onSourceStatus?.(kind, false);
        }
      });

      return {
        activeSources: streams.map((item) => item.kind),
        warnings: failures,
        async stop() {
          if (stopped) return;
          stopped = true;
          worklet.port.onmessage = null;
          if (micWorklet) micWorklet.port.onmessage = null;
          for (const { stream } of streams) {
            for (const track of stream.getTracks()) track.stop();
          }
          for (const { source } of sources) source.disconnect();
          mixer.disconnect();
          worklet.disconnect();
          micWorklet?.disconnect();
          mute.disconnect();
          await ctx.close();
        },
      };
    } catch (err) {
      for (const { stream } of streams) {
        for (const track of stream.getTracks()) track.stop();
      }
      if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
      throw err;
    }
  }

  window.audioCaptureApi = { start };
})();
