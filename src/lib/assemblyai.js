import VAD from './vad';
import { request } from './request';
import Recorder from './recorder';
import resampler from 'audio-resampler';

const API_ENDPOINT = 'https://api.assemblyai.com/v2/stream/avs';

export default class AssemblyAI {
  constructor(token, params = {}) {
    this.token = token;

    const browser = navigator && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    this.PCM_DATA_SAMPLE_RATE = browser ? 44100 : 16000;

    console.log(`Running on Safari: ${browser}`);

    // Default callbacks
    this.callbacks = {
      start: () => {},
      stop: () => {},
      complete: () => {},
      error: () => {}
    };

    const _params = {};

    if(params.word_boost){
      if(params.word_boost.length > 100){
        setTimeout(() => {
          this.callbacks.error({error: 'The word_boost parameter can be a max of 100 terms'});
        }, 4);
        return;
      }
      if(!params.word_boost.every(v => typeof v === 'string')){
        setTimeout(() => {
          this.callbacks.error({error: 'The word_boost parameter only accepts string terms'});
        }, 4);
        return;
      }
      _params['word_boost'] = params.word_boost;
    }

    if(params.format_text !== undefined){
      if(typeof params.format_text !== 'boolean'){
        setTimeout(() => {
          this.callbacks.error({error: 'The format_text parameter only accepts boolean values (true / false)'});
        }, 4);
        return;
      }

      _params['format_text'] = params.format_text;
    }

    this.params = _params;
  }

  /**
   * Function that starts the recording
   */
  start() {
    if (
      this.source &&
      this.source.context &&
      typeof this.source.context.resume === 'function'
    ) {
      this.source.context.resume();
    }

    return Promise.resolve()
      .then(() => {
        if (!this.recorder) {
          const audioContext = new (window.AudioContext ||
            window.webkitAudioContext)();

          let onaudioprocess;

          new VAD({
            context: audioContext,
            onaudioprocess: (func) => {
              onaudioprocess = func;
            },
            voice_stop: () => {
              if (this.isRecording) {
                this.stop();
              }
            }
          });

          this.recorder = new Recorder(audioContext, {
            onAnalysed: ({data}) => onaudioprocess && onaudioprocess(data)
          });

          return navigator.mediaDevices
            .getUserMedia({
              audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 1
              }
            })
            .then(stream => {
              this.recorder.init(stream);

              this.recordingTimer = setTimeout(() => {
                console.log('AssemblyAI: Recording stopped because it has reached the limit of 15 seconds.');
                this.stop();
              }, 15000);
            })
            .catch(err => {
              this.callbacks.error(err);
            });
        }
      })
      .then(() => {
        this.recorder.start().then(() => {
          this.isRecording = true;
          this.callbacks.start();
        });
      });
  }

  /**
   * Function that stops the recording
   */
  stop() {
    this.isRecording = false;
    this.callbacks.stop();

    if(this.recordingTimer){
      clearTimeout(this.recordingTimer);
    }

    const stopRecording = () => {
      if (
        this.source &&
        this.source.mediaStream &&
        typeof this.source.mediaStream.getTracks === 'function'
      ) {
        const tracks = this.source.mediaStream.getTracks();
        // we need to make a new recorder for every time the user presses the button,
        // otherwise we keep recording.
        tracks.forEach(track => track.stop());
        this.recorder = undefined;
      }
    };

    return Promise.resolve()
      .then(() => {
        if (this.recorder) {
          return this.recorder.stop();
        }
        throw new Error('no recorder');
      })
      .then(({ buffer }) => {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const newBuffer = audioContext.createBuffer( 1, buffer[0].length, audioContext.sampleRate );
        newBuffer.getChannelData(0).set(buffer[0]);

        return this.resample(newBuffer);
      })
      .then((buffer) => {
        console.log('audio', buffer);
        const wav = this._createWaveFileData(buffer);

        return this._transcribe(btoa(this._uint8ToString(wav)));
      })
      .then(stopRecording)
      .catch(e => {
        console.log(e);

        return stopRecording();
      });
  }

  /**
   * Function that registers event listeners.
   * @param {string} event Event name. Valid options: start, stop, complete, error.
   * @param {function} callback Function that will be called when event is fired.
   */
  on(event, callback) {
    switch (event) {
      case 'start': {
        this.callbacks.start = callback;
        break;
      }
      case 'stop': {
        this.callbacks.stop = callback;
        break;
      }
      case 'complete': {
        this.callbacks.complete = callback;
        break;
      }
      case 'error': {
        this.callbacks.error = callback;
        break;
      }
      default: {
        console.error(`Event ${event} does not exist.`);
      }
    }
  }

  /**
   * Function that gets a transcript from AssemblyAI API.
   * @param {base64} audio_data Audio recording.
   */
  _transcribe(audio_data) {
    return request(API_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ audio_data, sample_rate: this.PCM_DATA_SAMPLE_RATE, ...this.params}),
      headers: {
        authorization: this.token,
        'Content-Type': 'application/json; charset=utf-8'
      }
    })
      .then(res => res.json())
      .then(data => {
        if(!data.text){
          return this.callbacks.error({error: 'No speech detected. Please try again'});
        }

        this.callbacks.complete(data);
      })
      .catch((e) => {
        this.callbacks.error(e);
      });
  }

  resample(buffer){
    if(this.PCM_DATA_SAMPLE_RATE === 44100){
      return Promise.resolve(buffer);
    }

    return new Promise((resolve) => {
      resampler(
        buffer,
        this.PCM_DATA_SAMPLE_RATE,
        ({ getAudioBuffer }) => {
          resolve(getAudioBuffer());
        }
      );
    })
  }

  _uint8ToString(buf) {
    return Array.prototype.map.call(buf, i => String.fromCharCode(i)).join('');
  }

  _createWaveFileData(audioBuffer) {
    const frameLength = audioBuffer.length;
    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numberOfChannels * bitsPerSample) / 8;
    const blockAlign = (numberOfChannels * bitsPerSample) / 8;
    const wavDataByteLength = frameLength * numberOfChannels * 2; // 16-bit audio
    const headerByteLength = 44;
    const totalLength = headerByteLength + wavDataByteLength;

    const waveFileData = new Uint8Array(totalLength);

    const subChunk1Size = 16; // for linear PCM
    const subChunk2Size = wavDataByteLength;
    const chunkSize = 4 + (8 + subChunk1Size) + (8 + subChunk2Size);

    this._writeString('RIFF', waveFileData, 0);
    this._writeInt32(chunkSize, waveFileData, 4);
    this._writeString('WAVE', waveFileData, 8);
    this._writeString('fmt ', waveFileData, 12);

    this._writeInt32(subChunk1Size, waveFileData, 16); // SubChunk1Size (4)
    this._writeInt16(1, waveFileData, 20); // AudioFormat (2)
    this._writeInt16(numberOfChannels, waveFileData, 22); // NumChannels (2)
    this._writeInt32(sampleRate, waveFileData, 24); // SampleRate (4)
    this._writeInt32(byteRate, waveFileData, 28); // ByteRate (4)
    this._writeInt16(blockAlign, waveFileData, 32); // BlockAlign (2)
    this._writeInt32(bitsPerSample, waveFileData, 34); // BitsPerSample (4)

    this._writeString('data', waveFileData, 36);
    this._writeInt32(subChunk2Size, waveFileData, 40); // SubChunk2Size (4)

    // Write actual audio data starting at offset 44.
    this._writeAudioBuffer(audioBuffer, waveFileData, 44);

    return waveFileData;
  }

  _writeString(s, a, offset) {
    for (let i = 0; i < s.length; ++i) {
      a[offset + i] = s.charCodeAt(i);
    }
  }

  _writeInt16(n, a, offset) {
    n = Math.floor(n);

    a[offset + 0] = n & 255;
    a[offset + 1] = (n >> 8) & 255;
  }

  _writeInt32(n, a, offset) {
    n = Math.floor(n);

    a[offset + 0] = n & 255;
    a[offset + 1] = (n >> 8) & 255;
    a[offset + 2] = (n >> 16) & 255;
    a[offset + 3] = (n >> 24) & 255;
  }

  _writeAudioBuffer(audioBuffer, a, offset) {
    let n = audioBuffer.length;
    let channels = audioBuffer.numberOfChannels;

    for (let i = 0; i < n; ++i) {
      for (let k = 0; k < channels; ++k) {
        let buffer = audioBuffer.getChannelData(k);
        let sample = buffer[i] * 32768.0;

        // Clip samples to the limitations of 16-bit.
        // If we don't do this then we'll get nasty wrap-around distortion.
        if (sample < -32768) sample = -32768;
        if (sample > 32767) sample = 32767;

        this._writeInt16(sample, a, offset);
        offset += 2;
      }
    }
  }
}