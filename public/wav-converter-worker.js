// Web Worker for WAV to MP3 conversion using lamejs
// This runs in a separate thread so it doesn't block the UI

importScripts('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');

self.onmessage = async function(e) {
  const { wavData, sampleRate, numChannels } = e.data;

  try {
    // Decode WAV data
    self.postMessage({ type: 'progress', progress: 5, status: 'Decoding audio...' });

    const dataView = new DataView(wavData);

    // Read WAV header
    const wavSampleRate = dataView.getUint32(24, true);
    const bitsPerSample = dataView.getUint16(34, true);
    const wavNumChannels = dataView.getUint16(22, true);

    // Find data chunk
    let dataOffset = 44; // Standard WAV header size
    // Some WAV files have extra chunks, search for 'data'
    for (let i = 12; i < Math.min(wavData.byteLength - 4, 1000); i++) {
      if (dataView.getUint8(i) === 0x64 && // 'd'
          dataView.getUint8(i+1) === 0x61 && // 'a'
          dataView.getUint8(i+2) === 0x74 && // 't'
          dataView.getUint8(i+3) === 0x61) { // 'a'
        dataOffset = i + 8; // Skip 'data' + size (4 bytes)
        break;
      }
    }

    // Extract PCM samples
    const bytesPerSample = bitsPerSample / 8;
    const numSamples = Math.floor((wavData.byteLength - dataOffset) / (bytesPerSample * wavNumChannels));

    self.postMessage({ type: 'progress', progress: 10, status: 'Preparing audio data...' });

    const leftChannel = new Int16Array(numSamples);
    const rightChannel = new Int16Array(numSamples);

    // Read samples based on bit depth
    for (let i = 0; i < numSamples; i++) {
      const offset = dataOffset + i * bytesPerSample * wavNumChannels;

      if (bitsPerSample === 16) {
        leftChannel[i] = dataView.getInt16(offset, true);
        rightChannel[i] = wavNumChannels > 1 ? dataView.getInt16(offset + 2, true) : leftChannel[i];
      } else if (bitsPerSample === 24) {
        // Convert 24-bit to 16-bit
        const sample = (dataView.getUint8(offset + 2) << 16) | (dataView.getUint8(offset + 1) << 8) | dataView.getUint8(offset);
        leftChannel[i] = (sample > 0x7FFFFF ? sample - 0x1000000 : sample) >> 8;
        if (wavNumChannels > 1) {
          const sample2 = (dataView.getUint8(offset + 5) << 16) | (dataView.getUint8(offset + 4) << 8) | dataView.getUint8(offset + 3);
          rightChannel[i] = (sample2 > 0x7FFFFF ? sample2 - 0x1000000 : sample2) >> 8;
        } else {
          rightChannel[i] = leftChannel[i];
        }
      } else if (bitsPerSample === 32) {
        // 32-bit float or int
        leftChannel[i] = Math.max(-32768, Math.min(32767, Math.floor(dataView.getFloat32(offset, true) * 32767)));
        rightChannel[i] = wavNumChannels > 1
          ? Math.max(-32768, Math.min(32767, Math.floor(dataView.getFloat32(offset + 4, true) * 32767)))
          : leftChannel[i];
      }

      // Progress update every 10%
      if (i % Math.floor(numSamples / 10) === 0) {
        const prepProgress = 10 + Math.floor((i / numSamples) * 10);
        self.postMessage({ type: 'progress', progress: prepProgress, status: 'Preparing audio data...' });
      }
    }

    self.postMessage({ type: 'progress', progress: 20, status: 'Encoding MP3...' });

    // Create MP3 encoder - 192kbps stereo
    const mp3encoder = new lamejs.Mp3Encoder(wavNumChannels, wavSampleRate, 192);
    const mp3Data = [];

    // Encode in chunks
    const chunkSize = 1152;
    let processedSamples = 0;

    for (let i = 0; i < numSamples; i += chunkSize) {
      const leftChunk = leftChannel.subarray(i, Math.min(i + chunkSize, numSamples));
      const rightChunk = rightChannel.subarray(i, Math.min(i + chunkSize, numSamples));

      let mp3buf;
      if (wavNumChannels === 1) {
        mp3buf = mp3encoder.encodeBuffer(leftChunk);
      } else {
        mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
      }

      if (mp3buf.length > 0) {
        mp3Data.push(new Uint8Array(mp3buf));
      }

      processedSamples += chunkSize;

      // Update progress every ~1%
      if (processedSamples % (chunkSize * 100) < chunkSize) {
        const encodeProgress = 20 + Math.floor((i / numSamples) * 75);
        const percent = Math.floor((i / numSamples) * 100);
        self.postMessage({ type: 'progress', progress: encodeProgress, status: `Encoding MP3... ${percent}%` });
      }
    }

    // Flush remaining data
    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) {
      mp3Data.push(new Uint8Array(mp3buf));
    }

    self.postMessage({ type: 'progress', progress: 97, status: 'Finalizing...' });

    // Combine all chunks
    const totalLength = mp3Data.reduce((acc, chunk) => acc + chunk.length, 0);
    const mp3Array = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of mp3Data) {
      mp3Array.set(chunk, offset);
      offset += chunk.length;
    }

    self.postMessage({ type: 'progress', progress: 100, status: 'Conversion complete!' });
    self.postMessage({ type: 'complete', mp3Data: mp3Array.buffer }, [mp3Array.buffer]);

  } catch (error) {
    self.postMessage({ type: 'error', error: error.message });
  }
};
