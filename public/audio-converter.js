// audio-converter.js
// Client-side audio conversion using Web Audio API + lamejs
// Converts WAV↔MP3 in the browser, no server memory limits

class AudioConverter {
  constructor() {
    this.audioContext = null;
    this.onProgress = null;
  }

  async init() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  // Convert audio file to target format
  async convert(sourceUrl, sourceFormat, targetFormat, trackName, onProgress) {
    this.onProgress = onProgress || (() => {});

    await this.init();

    this.onProgress({ stage: 'downloading', progress: 0, message: 'Downloading original file...' });

    // 1. Fetch source file
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error('Failed to download source file');

    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    // Stream download with progress
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total > 0) {
        this.onProgress({
          stage: 'downloading',
          progress: Math.round((loaded / total) * 100),
          message: `Downloading: ${Math.round(loaded / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB`
        });
      }
    }

    const sourceData = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      sourceData.set(chunk, offset);
      offset += chunk.length;
    }

    this.onProgress({ stage: 'decoding', progress: 0, message: 'Decoding audio...' });

    // 2. Decode audio
    const audioBuffer = await this.audioContext.decodeAudioData(sourceData.buffer);

    this.onProgress({ stage: 'converting', progress: 0, message: `Converting to ${targetFormat.toUpperCase()}...` });

    // 3. Convert to target format
    let outputBlob;
    if (targetFormat === 'mp3') {
      outputBlob = await this.encodeToMp3(audioBuffer);
    } else if (targetFormat === 'wav') {
      outputBlob = this.encodeToWav(audioBuffer);
    } else {
      throw new Error(`Unsupported target format: ${targetFormat}`);
    }

    this.onProgress({ stage: 'complete', progress: 100, message: 'Conversion complete!' });

    // 4. Trigger download
    const filename = `${trackName}.${targetFormat}`;
    this.downloadBlob(outputBlob, filename);

    return { blob: outputBlob, filename };
  }

  // Encode AudioBuffer to MP3 using lamejs
  async encodeToMp3(audioBuffer) {
    // Load lamejs dynamically if not already loaded
    if (typeof lamejs === 'undefined') {
      await this.loadScript('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');
    }

    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const samples = audioBuffer.length;

    // Get channel data
    const left = audioBuffer.getChannelData(0);
    const right = channels > 1 ? audioBuffer.getChannelData(1) : left;

    // Convert float32 to int16
    const leftInt = this.floatTo16BitPCM(left);
    const rightInt = this.floatTo16BitPCM(right);

    // Initialize encoder
    const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, 320); // 320kbps
    const mp3Data = [];

    // Encode in chunks
    const blockSize = 1152;
    const totalBlocks = Math.ceil(samples / blockSize);

    for (let i = 0; i < samples; i += blockSize) {
      const leftChunk = leftInt.subarray(i, Math.min(i + blockSize, samples));
      const rightChunk = rightInt.subarray(i, Math.min(i + blockSize, samples));

      let mp3buf;
      if (channels === 1) {
        mp3buf = mp3encoder.encodeBuffer(leftChunk);
      } else {
        mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
      }

      if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
      }

      // Progress update
      const currentBlock = Math.floor(i / blockSize);
      if (currentBlock % 100 === 0) {
        this.onProgress({
          stage: 'converting',
          progress: Math.round((currentBlock / totalBlocks) * 100),
          message: `Converting to MP3: ${Math.round((currentBlock / totalBlocks) * 100)}%`
        });
      }
    }

    // Flush remaining data
    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }

    // Combine all chunks
    const totalLength = mp3Data.reduce((sum, buf) => sum + buf.length, 0);
    const mp3Output = new Uint8Array(totalLength);
    let outputOffset = 0;
    for (const buf of mp3Data) {
      mp3Output.set(buf, outputOffset);
      outputOffset += buf.length;
    }

    return new Blob([mp3Output], { type: 'audio/mp3' });
  }

  // Encode AudioBuffer to WAV
  encodeToWav(audioBuffer) {
    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const samples = audioBuffer.length;
    const bytesPerSample = 2; // 16-bit

    // Calculate sizes
    const dataLength = samples * channels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // Write WAV header
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    this.writeString(view, 8, 'WAVE');
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
    view.setUint16(32, channels * bytesPerSample, true); // block align
    view.setUint16(34, bytesPerSample * 8, true); // bits per sample
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // Write audio data (interleaved)
    let offset = 44;
    const channelData = [];
    for (let c = 0; c < channels; c++) {
      channelData.push(audioBuffer.getChannelData(c));
    }

    for (let i = 0; i < samples; i++) {
      for (let c = 0; c < channels; c++) {
        const sample = Math.max(-1, Math.min(1, channelData[c][i]));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }

      // Progress update every 10000 samples
      if (i % 10000 === 0) {
        this.onProgress({
          stage: 'converting',
          progress: Math.round((i / samples) * 100),
          message: `Converting to WAV: ${Math.round((i / samples) * 100)}%`
        });
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  // Helper: Float32 to Int16
  floatTo16BitPCM(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
  }

  // Helper: Write string to DataView
  writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  // Helper: Load external script
  loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // Helper: Download blob as file
  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// Export for use
window.AudioConverter = AudioConverter;

// Convenience function
window.convertAndDownload = async function(sourceUrl, sourceFormat, targetFormat, trackName, onProgress) {
  const converter = new AudioConverter();
  return converter.convert(sourceUrl, sourceFormat, targetFormat, trackName, onProgress);
};
