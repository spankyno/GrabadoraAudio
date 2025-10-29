import React, { useState, useRef, useCallback, useEffect } from 'react';
import { MicrophoneIcon, StopIcon, DownloadIcon, AlertIcon } from './components/Icons';
import * as lamejs from 'lamejs';

type Status = 'idle' | 'recording' | 'stopped' | 'error';
type AudioFormat = 'webm' | 'wav' | 'mp3';

const App: React.FC = () => {
  const [status, setStatus] = useState<Status>('idle');
  const [audioURL, setAudioURL] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<AudioFormat>('webm');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isWavSupported, setIsWavSupported] = useState(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameIdRef = useRef<number>(0);

  useEffect(() => {
    setIsWavSupported(MediaRecorder.isTypeSupported('audio/wav'));
  }, []);

  const drawVisualization = useCallback((analyser: AnalyserNode) => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const canvasCtx = canvas.getContext('2d');
    
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationFrameIdRef.current = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);

      if (!canvasCtx) return;
      canvasCtx.fillStyle = 'rgb(31, 41, 55)'; // bg-gray-800
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
      
      canvasCtx.lineWidth = 2;
      canvasCtx.strokeStyle = 'rgb(56, 189, 248)'; // cyan-400

      canvasCtx.beginPath();
      const sliceWidth = (canvas.width * 1.0) / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;

        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      canvasCtx.lineTo(canvas.width, canvas.height / 2);
      canvasCtx.stroke();
    };

    draw();
  }, []);

  useEffect(() => {
    if (status === 'recording' && audioStreamRef.current) {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(audioStreamRef.current);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;

      const gainNode = audioContext.createGain();
      gainNode.gain.value = 0;
      
      source.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      drawVisualization(analyser);

      return () => {
        cancelAnimationFrame(animationFrameIdRef.current);
        source.disconnect();
        analyser.disconnect();
        gainNode.disconnect();
        if (audioContext.state !== 'closed') {
          audioContext.close();
        }
      };
    }
  }, [status, drawVisualization]);

  const handleStartRecording = useCallback(async () => {
    setError(null);
    setAudioURL(null);
    recordedChunksRef.current = [];
    
    let mimeType = format === 'wav' ? 'audio/wav' : 'audio/webm';
    if (format === 'mp3') {
        mimeType = 'audio/wav'; // Grabar en WAV para codificar a MP3
    }

    if (!MediaRecorder.isTypeSupported(mimeType)) {
        setError(`El formato necesario (${mimeType}) no es compatible con tu navegador.`);
        setStatus('error');
        return;
    }

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      displayStreamRef.current = displayStream;
      
      const audioTracks = displayStream.getAudioTracks();

      if (audioTracks.length === 0) {
        setError("No se detectó una pista de audio. Asegúrate de compartir el audio del sistema o de la pestaña.");
        displayStream.getTracks().forEach(track => track.stop());
        setStatus('error');
        return;
      }
      
      audioStreamRef.current = new MediaStream(audioTracks);

      const recorder = new MediaRecorder(audioStreamRef.current, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const recordedBlob = new Blob(recordedChunksRef.current, { type: mimeType });
        
        if (format === 'mp3') {
            setIsProcessing(true);
            try {
                const arrayBuffer = await recordedBlob.arrayBuffer();
                const wav = lamejs.WavHeader.readHeader(new DataView(arrayBuffer));
                const samples = new Int16Array(arrayBuffer, wav.dataOffset, wav.dataLen / 2);
                const encoder = new lamejs.Mp3Encoder(wav.channels, wav.sampleRate, 128); // 128 kbps
                
                const mp3Data = [];
                const sampleBlockSize = 1152;
                for (let i = 0; i < samples.length; i += sampleBlockSize) {
                    const sampleChunk = samples.subarray(i, i + sampleBlockSize);
                    const mp3buf = encoder.encodeBuffer(sampleChunk);
                    if (mp3buf.length > 0) mp3Data.push(mp3buf);
                }
                const mp3buf = encoder.flush();
                if (mp3buf.length > 0) mp3Data.push(mp3buf);

                const mp3Blob = new Blob(mp3Data, { type: 'audio/mpeg' });
                setAudioURL(URL.createObjectURL(mp3Blob));
            } catch (e) {
                console.error("Error encoding MP3:", e);
                setError("No se pudo convertir el audio a MP3.");
                setStatus('error');
            } finally {
                setIsProcessing(false);
            }
        } else {
            setAudioURL(URL.createObjectURL(recordedBlob));
        }

        setStatus('stopped');
        displayStreamRef.current?.getTracks().forEach(track => track.stop());
      };
      
      recorder.onerror = (event) => {
        setError(`Error de grabación: ${(event as any).error.name}`);
        setStatus('error');
      }

      recorder.start();
      setStatus('recording');

    } catch (err) {
      console.error("Error starting recording:", err);
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setError("Permiso denegado. Debes permitir el acceso para poder grabar.");
      } else if (err instanceof Error && err.message.includes("permissions policy")) {
        setError("Error de permisos. La captura de pantalla no está permitida en este contexto.");
      }
      else {
        setError("No se pudo iniciar la grabación. Verifica los permisos de tu navegador.");
      }
      setStatus('error');
    }
  }, [format]);

  const handleStopRecording = useCallback(() => {
    if (mediaRecorderRef.current && status === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, [status]);

  const handleDownload = useCallback(() => {
    if (audioURL) {
      const a = document.createElement('a');
      a.href = audioURL;
      a.download = `grabacion-${new Date().toISOString()}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }, [audioURL, format]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 font-sans p-4">
      <div className="w-full max-w-md mx-auto bg-gray-800 rounded-2xl shadow-2xl p-6 sm:p-8 space-y-6 transform transition-all duration-300">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-cyan-400">Grabadora de Audio del PC</h1>
          <p className="text-gray-400 mt-2">Graba el sonido de cualquier pestaña o de todo tu sistema.</p>
        </div>

        <div className="bg-gray-900/50 p-4 rounded-lg border border-gray-700 text-sm text-gray-300 flex items-start space-x-3">
          <div className="flex-shrink-0 pt-1">
            <AlertIcon className="w-5 h-5 text-yellow-400" />
          </div>
          <p>
            Al hacer clic en 'Grabar', tu navegador te pedirá que compartas tu pantalla. 
            <span className="font-semibold text-yellow-300"> Es crucial que marques la opción "Compartir audio de la pestaña" o "Compartir audio del sistema"</span> para que la grabación funcione.
          </p>
        </div>
        
        <div className="bg-gray-900/50 p-4 rounded-lg border border-gray-700">
            <h3 className="text-md font-semibold text-gray-200 mb-3 text-center">Formato de Audio</h3>
            <fieldset className="grid grid-cols-3 gap-2" disabled={status === 'recording'}>
                <legend className="sr-only">Elige un formato de audio</legend>
                <div>
                    <input type="radio" id="format-webm" name="format" value="webm" checked={format === 'webm'} onChange={() => setFormat('webm')} className="peer hidden" />
                    <label htmlFor="format-webm" className="block cursor-pointer rounded-md border border-gray-600 py-2 px-3 text-center text-sm transition-colors duration-200 peer-checked:bg-cyan-500 peer-checked:border-cyan-500 peer-disabled:opacity-50 peer-disabled:cursor-not-allowed hover:border-gray-500 peer-checked:hover:bg-cyan-600">
                        WebM <span className="block text-xs text-gray-400">Reducido</span>
                    </label>
                </div>
                <div>
                    <input type="radio" id="format-wav" name="format" value="wav" checked={format === 'wav'} onChange={() => setFormat('wav')} className="peer hidden" />
                    <label htmlFor="format-wav" className="block cursor-pointer rounded-md border border-gray-600 py-2 px-3 text-center text-sm transition-colors duration-200 peer-checked:bg-cyan-500 peer-checked:border-cyan-500 peer-disabled:opacity-50 peer-disabled:cursor-not-allowed hover:border-gray-500 peer-checked:hover:bg-cyan-600">
                        WAV <span className="block text-xs text-gray-400">Calidad Alta</span>
                    </label>
                </div>
                <div>
                    <input type="radio" id="format-mp3" name="format" value="mp3" checked={format === 'mp3'} onChange={() => setFormat('mp3')} className="peer hidden" disabled={!isWavSupported}/>
                    <label htmlFor="format-mp3" title={!isWavSupported ? "Tu navegador no soporta la grabación en WAV, necesaria para crear MP3." : ""} className="block cursor-pointer rounded-md border border-gray-600 py-2 px-3 text-center text-sm transition-colors duration-200 peer-checked:bg-cyan-500 peer-checked:border-cyan-500 peer-disabled:opacity-50 peer-disabled:cursor-not-allowed hover:border-gray-500 peer-checked:hover:bg-cyan-600">
                        MP3 <span className="block text-xs text-gray-400">Compatible</span>
                    </label>
                </div>
            </fieldset>
        </div>

        <div className="flex flex-col justify-center items-center h-40">
           {status === 'recording' && (
            <canvas ref={canvasRef} className="w-full h-20 mb-4 rounded-md" style={{ animation: 'fadeIn 0.5s ease-in-out' }} />
          )}
          <button
            onClick={status === 'recording' ? handleStopRecording : handleStartRecording}
            className={`
              flex items-center justify-center text-white
              transition-all duration-300 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-4
              ${status === 'recording' ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500/50 w-24 h-24' : 'bg-cyan-500 hover:bg-cyan-600 focus:ring-cyan-500/50 w-32 h-32'}
              rounded-full shadow-lg
            `}
            aria-label={status === 'recording' ? 'Detener grabación' : 'Iniciar grabación'}
          >
            {status === 'recording' ? <StopIcon className="w-10 h-10" /> : <MicrophoneIcon className="w-12 h-12" />}
          </button>
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-md text-center">
            {error}
          </div>
        )}
        
        {isProcessing && (
            <div className="flex flex-col items-center justify-center text-center bg-gray-900/50 p-4 rounded-lg border border-gray-700">
               <svg className="animate-spin h-8 w-8 text-cyan-400 mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                 <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                 <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
               </svg>
               <p className="text-lg font-semibold text-cyan-400">Procesando MP3...</p>
               <p className="text-sm text-gray-400">Esto puede tardar unos segundos.</p>
            </div>
        )}

        <div className="space-y-4">
          <div className="h-16">
            {audioURL && status === 'stopped' && !isProcessing && (
              <div className="flex flex-col items-center space-y-4" style={{ animation: 'fadeIn 0.5s ease-in-out' }}>
                <audio controls src={audioURL} className="w-full rounded-md">
                  Tu navegador no soporta el elemento de audio.
                </audio>
              </div>
            )}
          </div>
          <div className="h-12">
            {audioURL && status === 'stopped' && !isProcessing && (
              <button
                onClick={handleDownload}
                disabled={!audioURL}
                className="
                  w-full h-12 px-6 bg-green-600 text-white rounded-md flex items-center justify-center
                  font-semibold transition-colors duration-300 ease-in-out
                  hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed
                  focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-green-500
                "
                style={{ animation: 'fadeIn 0.5s ease-in-out' }}
              >
                <DownloadIcon className="w-5 h-5 mr-2" />
                Descargar Grabación
              </button>
            )}
          </div>
        </div>
      </div>
       <footer className="text-center mt-8 text-gray-500 text-sm">
        <p>Creado con React, Tailwind CSS y la Web Audio API.</p>
      </footer>
    </div>
  );
};

export default App;