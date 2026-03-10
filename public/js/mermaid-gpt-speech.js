/**
 * MermaidSpeech — Talk-to-Text for Mermate.
 *
 * Captures audio via MediaRecorder, uploads to /api/transcribe (Whisper),
 * and inserts the transcribed text into the textarea.
 *
 * Exposed as window.MermaidSpeech.
 */
window.MermaidSpeech = class MermaidSpeech {
  constructor(inputEl, btnMic, opts = {}) {
    this.input = inputEl;
    this.btn = btnMic;
    this.onInsert = opts.onInsert || (() => {});
    this.onError = opts.onError || (() => {});

    this._recording = false;
    this._processing = false;
    this._mediaRecorder = null;
    this._chunks = [];
    this._stream = null;

    if (this.btn) {
      this.btn.addEventListener('click', () => this.toggle());
    }
  }

  get recording() { return this._recording; }
  get processing() { return this._processing; }

  async toggle() {
    if (this._processing) return;
    if (this._recording) {
      this.stop();
    } else {
      await this.start();
    }
  }

  async start() {
    if (this._recording || this._processing) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.onError('Your browser does not support microphone access.');
      return;
    }

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        this.onError('Microphone permission denied. Allow access in your browser settings.');
      } else {
        this.onError(`Microphone error: ${err.message}`);
      }
      return;
    }

    this._chunks = [];
    const mimeType = this._pickMimeType();

    try {
      this._mediaRecorder = new MediaRecorder(this._stream, { mimeType });
    } catch {
      this._mediaRecorder = new MediaRecorder(this._stream);
    }

    this._mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };

    this._mediaRecorder.onstop = () => this._handleRecordingComplete();

    this._mediaRecorder.start(250);
    this._recording = true;
    this._updateUI('recording');

    if (this.btn) {
      const label = this.btn.querySelector('.mic-label');
      if (label) label.textContent = 'Recording...';
    }
  }

  stop() {
    if (!this._recording || !this._mediaRecorder) return;
    this._recording = false;
    this._mediaRecorder.stop();
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
  }

  async _handleRecordingComplete() {
    if (this._chunks.length === 0) {
      this._updateUI('idle');
      this.onError('No audio captured.');
      return;
    }

    this._processing = true;
    this._updateUI('processing');
    if (this.btn) {
      const label = this.btn.querySelector('.mic-label');
      if (label) label.textContent = 'Transcribing';
    }

    const mimeType = this._mediaRecorder?.mimeType || 'audio/webm';
    const blob = new Blob(this._chunks, { type: mimeType });
    this._chunks = [];
    this._mediaRecorder = null;

    try {
      const form = new FormData();
      form.append('audio', blob, `recording.${this._extFromMime(mimeType)}`);

      const resp = await fetch('/api/transcribe', { method: 'POST', body: form });
      const data = await resp.json();

      if (!data.success && data.error) {
        this.onError(data.details || data.error || 'Transcription failed.');
        return;
      }

      const text = (data.text || '').trim();
      if (!text) {
        if (data.warning) {
          this.onError(data.warning);
        } else {
          this.onError('No speech detected. Try speaking more clearly.');
        }
        return;
      }

      this._insertText(text);
      this.onInsert(text);

    } catch (err) {
      this.onError(`Transcription error: ${err.message}`);
    } finally {
      this._processing = false;
      this._updateUI('idle');
      if (this.btn) {
        const label = this.btn.querySelector('.mic-label');
        if (label) label.textContent = 'Speak your mind';
      }
    }
  }

  _insertText(text) {
    const ta = this.input;
    const selStart = ta.selectionStart;
    const selEnd = ta.selectionEnd;
    const before = ta.value.slice(0, selStart);
    const after = ta.value.slice(selEnd);

    const needsSpace = before.length > 0 && !before.endsWith('\n') && !before.endsWith(' ');
    const separator = needsSpace ? '\n\n' : '';

    ta.value = before + separator + text + after;
    const newCursor = (before + separator + text).length;
    ta.setSelectionRange(newCursor, newCursor);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }

  _updateUI(state) {
    if (!this.btn) return;
    this.btn.classList.remove('recording', 'processing');
    if (state === 'recording') this.btn.classList.add('recording');
    if (state === 'processing') this.btn.classList.add('processing');
  }

  _pickMimeType() {
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (const mt of preferred) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mt)) return mt;
    }
    return '';
  }

  _extFromMime(mime) {
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('wav')) return 'wav';
    return 'webm';
  }
};
