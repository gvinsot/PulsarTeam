export async function requestMicrophone(): Promise<MediaStream> {
  if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access requires HTTPS or localhost. Open the secure site URL.');
  }
  const policyDocument = document as Document & {
    permissionsPolicy?: { allowsFeature: (feature: string) => boolean };
    featurePolicy?: { allowsFeature: (feature: string) => boolean };
  };
  const policy = policyDocument.permissionsPolicy || policyDocument.featurePolicy;
  if (policy && !policy.allowsFeature('microphone')) {
    throw new Error(
      'Microphone blocked by the site Permissions-Policy or embedding frame. The server must allow microphone=(self); an embedded page also needs allow="microphone".'
    );
  }
  // getUserMedia is authoritative. A permissions.query preflight can report a
  // policy denial as a user denial and prevents the browser from asking at all.
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      throw new Error(
        'Microphone permission denied. Allow microphone access in this site’s browser permissions and in your operating system, then retry.'
      );
    }
    if (name === 'NotFoundError')
      throw new Error('No microphone found. Connect a microphone and retry.');
    if (name === 'NotReadableError')
      throw new Error(
        'Microphone unavailable. Check the device or close the application using it, then retry.'
      );
    throw error;
  }
}
