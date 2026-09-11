import type { VoiceSessionConfig, VoiceTransport, VoiceTransportOptions } from './types';

export function createOpenAiTransport(
  config: Extract<VoiceSessionConfig, { provider: 'openai' }>,
  options: VoiceTransportOptions
): VoiceTransport {
  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel('oai-events');
  const abort = new AbortController();
  let closed = false;
  let rejectReady: ((reason: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let responseActive = false;
  let responseRequested = false;
  const requestResponse = () => {
    if (closed || dc.readyState !== 'open' || responseActive || !responseRequested) return;
    responseRequested = false;
    responseActive = true;
    dc.send(JSON.stringify({ type: 'response.create' }));
  };
  const fail = (message: string) => {
    if (closed) return;
    rejectReady?.(new Error(message));
    transport.close();
    options.onError(message);
  };
  const transport: VoiceTransport = {
    async connect() {
      const ready = new Promise<void>((resolve, reject) => {
        rejectReady = reject;
        timer = setTimeout(() => fail('OpenAI voice connection timed out.'), 30000);
        dc.onopen = () => {
          if (closed) return;
          clearTimeout(timer);
          options.onConnected();
          resolve();
        };
      });
      // Handlers can reject while SDP fetch is still pending.
      void ready.catch(() => {});
      pc.ontrack = event => {
        if (closed) return;
        options.audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        void options.audio
          .play()
          .catch(() =>
            fail(
              'Browser blocked voice playback. Allow audio playback for this site, then reconnect.'
            )
          );
      };
      pc.onconnectionstatechange = () => {
        if (closed) return;
        if (pc.connectionState === 'failed') fail('OpenAI voice connection failed.');
        if (pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
          transport.close();
          options.onClose();
        }
      };
      dc.onmessage = event => {
        if (closed) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'response.created') responseActive = true;
          if (message.type === 'response.done') responseActive = false;
          options.onEvent(message);
          if (message.type === 'response.done') requestResponse();
        } catch {
          fail('Invalid OpenAI voice event.');
        }
      };
      dc.onerror = () => fail('OpenAI voice data channel failed.');
      dc.onclose = () => {
        if (!closed) {
          transport.close();
          options.onClose();
        }
      };
      options.stream.getTracks().forEach(track => pc.addTrack(track, options.stream));
      try {
        const offer = await pc.createOffer();
        if (closed) return;
        await pc.setLocalDescription(offer);
        if (closed) return;
        const response = await fetch(
          import.meta.env?.VITE_OPENAI_REALTIME_URL || 'https://api.openai.com/v1/realtime/calls',
          {
            method: 'POST',
            body: offer.sdp,
            headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/sdp' },
            signal: abort.signal,
          }
        );
        if (!response.ok) throw new Error(`OpenAI voice SDP exchange failed (${response.status}).`);
        const sdp = await response.text();
        if (closed) return;
        await pc.setRemoteDescription({ type: 'answer', sdp });
        await ready;
      } catch (error) {
        transport.close();
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      rejectReady?.(new Error('Voice connection closed.'));
      abort.abort();
      dc.close();
      pc.close();
      options.audio.pause();
      options.audio.srcObject = null;
    },
    sendFunctionOutput(callId, output) {
      if (closed || dc.readyState !== 'open') return;
      dc.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output,
          },
        })
      );
      responseRequested = true;
      requestResponse();
    },
    setMuted(muted) {
      options.stream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });
    },
    setSpeakerOff(off) {
      options.audio.muted = off;
    },
  };
  return transport;
}
