import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai';
import { WORKLET_CODE, decodePcm16ToBuffer } from '../externalVoiceClient';
import type { VoiceSessionConfig, VoiceTransport, VoiceTransportOptions } from './types';

export function createGeminiTransport(
  config: Extract<VoiceSessionConfig, { provider: 'gemini' }>,
  options: VoiceTransportOptions
): VoiceTransport {
  const ctx = new AudioContext();
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  const playing = new Set<AudioBufferSourceNode>();
  const calls = new Map<string, string>();
  let session: Session | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let closed = false;
  let muted = false;
  let nextAudioTime = 0;
  let responseStarted = false;
  let inputTranscript = '';
  let inputFinished = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectReady: ((reason: Error) => void) | undefined;
  let resolveReady: (() => void) | undefined;

  const stopAudio = () => {
    playing.forEach(node => {
      node.onended = null;
      node.stop();
      node.disconnect();
    });
    playing.clear();
    nextAudioTime = 0;
  };
  const fail = (message: string) => {
    if (closed) return;
    rejectReady?.(new Error(message));
    transport.close();
    options.onError(message);
  };
  const onMessage = (message: LiveServerMessage) => {
    if (closed) return;
    if (message.setupComplete) resolveReady?.();
    if (message.goAway) {
      fail('Gemini voice session is expiring. Reconnect to continue.');
      return;
    }
    for (const id of message.toolCallCancellation?.ids || []) calls.delete(id);
    const content = message.serverContent;
    if (content?.interrupted) {
      stopAudio();
      responseStarted = false;
      options.onEvent({ type: 'input_audio_buffer.speech_started' });
    }
    if (content?.inputTranscription?.text) {
      if (inputFinished) {
        inputTranscript = '';
        inputFinished = false;
      }
      inputTranscript += content.inputTranscription.text;
      options.onEvent({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: inputTranscript,
      });
      options.onEvent({ type: 'input_audio_buffer.speech_started' });
    }
    if (content?.inputTranscription?.finished) {
      inputFinished = true;
      options.onEvent({ type: 'input_audio_buffer.speech_stopped' });
    }
    if (content?.modelTurn || content?.outputTranscription) {
      if (!responseStarted) {
        responseStarted = true;
        options.onEvent({ type: 'response.created' });
      }
    }
    if (content?.outputTranscription?.text) {
      options.onEvent({
        type: 'response.output_audio_transcript.delta',
        delta: content.outputTranscription.text,
      });
    }
    for (const part of content?.modelTurn?.parts || []) {
      if (!part.inlineData?.data || !part.inlineData.mimeType?.startsWith('audio/pcm')) continue;
      const binary = atob(part.inlineData.data);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const rate = Number(part.inlineData.mimeType.match(/rate=(\d+)/)?.[1] || 24000);
      const node = ctx.createBufferSource();
      node.buffer = decodePcm16ToBuffer(ctx, bytes.buffer, rate);
      node.connect(gain);
      playing.add(node);
      nextAudioTime = Math.max(ctx.currentTime, nextAudioTime);
      node.start(nextAudioTime);
      nextAudioTime += node.buffer.duration;
      options.onEvent({ type: 'output_audio_buffer.started' });
      node.onended = () => {
        playing.delete(node);
        node.disconnect();
        if (!closed && playing.size === 0) options.onEvent({ type: 'output_audio_buffer.stopped' });
      };
    }
    for (const call of message.toolCall?.functionCalls || []) {
      if (!call.id || !call.name || calls.has(call.id)) continue;
      calls.set(call.id, call.name);
      options.onEvent({
        type: 'response.function_call_arguments.done',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args || {}),
      });
    }
    if (content?.turnComplete) {
      responseStarted = false;
      inputFinished = true;
      options.onEvent({ type: 'response.done' });
    }
  };

  const transport: VoiceTransport = {
    async connect() {
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
        timer = setTimeout(() => fail('Gemini voice connection timed out.'), 30000);
      });
      void ready.catch(() => {});
      try {
        await ctx.resume();
        if (closed) return;
        const url = URL.createObjectURL(
          new Blob([WORKLET_CODE], { type: 'application/javascript' })
        );
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        if (closed) return;
        const client = new GoogleGenAI({
          apiKey: config.token,
          httpOptions: { apiVersion: 'v1beta' },
        });
        const connection = client.live.connect({
          model: config.model,
          config: config.session,
          callbacks: {
            onmessage: message => {
              try {
                onMessage(message);
              } catch {
                fail('Invalid Gemini voice event.');
              }
            },
            onerror: () =>
              fail('Gemini voice connection failed. Check the network and model access.'),
            onclose: event => {
              if (closed) return;
              rejectReady?.(new Error('Gemini voice connection closed.'));
              if (event.code !== 1000)
                fail(`Gemini voice connection closed (${event.code}). Reconnect to retry.`);
              else {
                transport.close();
                options.onClose();
              }
            },
          },
        });
        // The SDK resolves only after setupComplete. Timeout/cancel must also
        // settle our connect when the remote WebSocket never completes setup.
        void connection.then(
          late => {
            if (closed) late.close();
          },
          () => {}
        );
        const connected = await Promise.race([connection, ready.then(() => connection)]);
        if (closed) {
          connected.close();
          return;
        }
        session = connected;
        await ready;
        if (closed) return;
        clearTimeout(timer);
        source = ctx.createMediaStreamSource(options.stream);
        worklet = new AudioWorkletNode(ctx, 'pcm-downsampler', {
          processorOptions: { targetRate: 16000 },
        });
        worklet.port.onmessage = (event: MessageEvent<{ pcm?: ArrayBuffer }>) => {
          if (closed || muted || !event.data.pcm) return;
          const bytes = new Uint8Array(event.data.pcm);
          const data = btoa(String.fromCharCode(...bytes));
          try {
            session?.sendRealtimeInput({ audio: { data, mimeType: 'audio/pcm;rate=16000' } });
          } catch {
            fail('Failed to send microphone audio to Gemini.');
          }
        };
        source.connect(worklet);
        // The processor has silent output, but needs an active destination to run.
        worklet.connect(ctx.destination);
        options.onConnected();
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
      if (worklet) {
        worklet.port.onmessage = null;
        worklet.disconnect();
        worklet.port.close();
      }
      source?.disconnect();
      stopAudio();
      session?.close();
      calls.clear();
      gain.disconnect();
      void ctx.close().catch(() => {});
    },
    sendFunctionOutput(callId, output) {
      const name = calls.get(callId);
      if (closed || !name) return; // Ignore responses to canceled calls.
      calls.delete(callId);
      try {
        session?.sendToolResponse({
          functionResponses: [{ id: callId, name, response: { result: output } }],
        });
      } catch {
        fail('Failed to send tool result to Gemini.');
      }
    },
    setMuted(value) {
      muted = value;
      options.stream.getAudioTracks().forEach(track => {
        track.enabled = !value;
      });
      if (value && session && !closed) session.sendRealtimeInput({ audioStreamEnd: true });
    },
    setSpeakerOff(off) {
      gain.gain.value = off ? 0 : 1;
    },
  };
  return transport;
}
