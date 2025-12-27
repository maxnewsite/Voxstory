
import React, { useState, useRef, useCallback } from 'react';
import { Character, Chapter, AudiobookState, PREBUILT_VOICES, ScriptSegment } from './types';
import { identifyChaptersAndCharacters, generateChapterScript, generateSpeech } from './services/geminiService';
import { audioBufferToWavBlob, concatenateAudioBuffers } from './utils/audioUtils';

const App: React.FC = () => {
  const [state, setState] = useState<AudiobookState>({
    title: 'New Audiobook',
    characters: [],
    chapters: [],
    isProcessing: false,
    currentStep: 'upload'
  });

  const [extractionProgress, setExtractionProgress] = useState({ current: 0, total: 0 });
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(-1);
  const [currentChapterId, setCurrentChapterId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [errorStatus, setErrorStatus] = useState<string | null>(null);
  const [isAiAnalyzing, setIsAiAnalyzing] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const currentPlayingIndexRef = useRef<number>(-1);
  const activeSegmentRef = useRef<HTMLDivElement>(null);

  const initAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorStatus(null);
    setState(prev => ({ ...prev, isProcessing: true, currentStep: 'analyzing', title: file.name.replace('.pdf', '') }));

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const typedarray = new Uint8Array(reader.result as ArrayBuffer);
        const pdfjsLib = (window as any)['pdfjs-dist/build/pdf'];
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        
        const pdf = await pdfjsLib.getDocument(typedarray).promise;
        let fullText = '';
        const totalPages = pdf.numPages;
        setExtractionProgress({ current: 0, total: totalPages });

        for (let i = 1; i <= totalPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map((item: any) => item.str).join(' ');
          fullText += pageText + '\n';
          setExtractionProgress({ current: i, total: totalPages });
          // Allow UI to update
          if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
        }

        setIsAiAnalyzing(true);
        const { chapters, characters } = await identifyChaptersAndCharacters(fullText);
        setIsAiAnalyzing(false);
        
        setState(prev => ({
          ...prev,
          characters,
          chapters: chapters as Chapter[],
          currentStep: 'configuring',
          isProcessing: false
        }));
      };
      reader.readAsArrayBuffer(file);
    } catch (error: any) {
      console.error(error);
      setErrorStatus("Failed to analyze PDF. Rate limit might have been exceeded.");
      setState(prev => ({ ...prev, isProcessing: false, currentStep: 'upload' }));
      setIsAiAnalyzing(false);
    }
  };

  const produceChapter = async (chapterId: string) => {
    const ctx = initAudioContext();
    setErrorStatus(null);
    setState(prev => ({
      ...prev,
      chapters: prev.chapters.map(ch => ch.id === chapterId ? { ...ch, isProcessing: true } : ch)
    }));

    try {
      const chapter = state.chapters.find(ch => ch.id === chapterId)!;
      const script = await generateChapterScript(chapter.content);
      
      const segmentsWithAudio: ScriptSegment[] = [];
      for (let i = 0; i < script.length; i++) {
        const seg = script[i];
        const speaker = state.characters.find(c => c.id === seg.speakerId || c.name === seg.speakerId) || state.characters.find(c => c.name === 'Narrator');
        const voice = speaker?.voiceName || 'charon';
        
        const buffer = await generateSpeech(seg.text, voice, ctx);
        segmentsWithAudio.push({ ...seg, audioBuffer: buffer });
        
        setState(prev => ({
          ...prev,
          chapters: prev.chapters.map(ch => ch.id === chapterId ? { 
            ...ch, 
            progress: Math.round(((i + 1) / script.length) * 100),
            segments: [...segmentsWithAudio]
          } : ch)
        }));

        // Small proactive artificial delay to spread out requests and stay under TPM limits
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      setState(prev => ({
        ...prev,
        chapters: prev.chapters.map(ch => ch.id === chapterId ? { 
          ...ch, 
          isProcessing: false, 
          isComplete: true, 
          segments: segmentsWithAudio 
        } : ch)
      }));
    } catch (error: any) {
      console.error(error);
      const isQuota = error?.message?.includes('429') || JSON.stringify(error).includes('429');
      setErrorStatus(isQuota ? "Rate limit reached. Try again in a minute." : "Production error occurred.");
      setState(prev => ({
        ...prev,
        chapters: prev.chapters.map(ch => ch.id === chapterId ? { ...ch, isProcessing: false } : ch)
      }));
    }
  };

  const downloadChapter = async (chapterId: string) => {
    const chapter = state.chapters.find(ch => ch.id === chapterId);
    if (!chapter || !chapter.isComplete) return;
    
    const buffers = chapter.segments.map(s => s.audioBuffer).filter((b): b is AudioBuffer => !!b);
    if (buffers.length === 0) return;

    const ctx = initAudioContext();
    const fullBuffer = await concatenateAudioBuffers(buffers, ctx);
    const blob = audioBufferToWavBlob(fullBuffer);
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.title} - ${chapter.title}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const playChapter = (chapterId: string, startIndex: number = 0) => {
    setCurrentChapterId(chapterId);
    playSegment(chapterId, startIndex);
  };

  const playSegment = useCallback((chapterId: string, index: number) => {
    const chapter = state.chapters.find(ch => ch.id === chapterId);
    if (!chapter || index >= chapter.segments.length) {
      setIsPlaying(false);
      setCurrentSegmentIndex(-1);
      return;
    }

    const segment = chapter.segments[index];
    if (!segment.audioBuffer) return;

    const ctx = initAudioContext();
    if (sourceNodeRef.current) try { sourceNodeRef.current.stop(); } catch(e) {}

    const source = ctx.createBufferSource();
    source.buffer = segment.audioBuffer;
    source.connect(ctx.destination);
    
    source.onended = () => {
      if (currentPlayingIndexRef.current === index) {
        playSegment(chapterId, index + 1);
      }
    };

    sourceNodeRef.current = source;
    currentPlayingIndexRef.current = index;
    setCurrentSegmentIndex(index);
    setIsPlaying(true);
    source.start(0);

    setTimeout(() => activeSegmentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }, [state.chapters]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center p-4 md:p-8">
      <header className="w-full max-w-6xl mb-12 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-xl">
             <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
          </div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">VoxStory <span className="text-indigo-600">Pro</span></h1>
        </div>
        {state.currentStep !== 'upload' && (
           <div className="hidden md:flex items-center gap-4 text-sm font-bold text-slate-400">
              <span className={state.currentStep === 'configuring' ? 'text-indigo-600' : ''}>CASTING</span>
              <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
              <span className={state.currentStep === 'production' ? 'text-indigo-600' : ''}>PRODUCTION</span>
              <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
              <span className={state.currentStep === 'playing' ? 'text-indigo-600' : ''}>LIBRARY</span>
           </div>
        )}
      </header>

      {errorStatus && (
        <div className="w-full max-w-6xl mb-8 bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-2xl font-bold flex items-center justify-between animate-in slide-in-from-top duration-300">
           <div className="flex items-center gap-3">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              {errorStatus}
           </div>
           <button onClick={() => setErrorStatus(null)} className="text-red-400 hover:text-red-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l18 18" /></svg>
           </button>
        </div>
      )}

      <main className="w-full max-w-6xl">
        {state.currentStep === 'upload' || state.currentStep === 'analyzing' ? (
          <div className="bg-white rounded-[40px] p-16 shadow-2xl flex flex-col items-center text-center max-w-3xl mx-auto border border-slate-100">
            {state.currentStep === 'upload' ? (
              <>
                <div className="w-24 h-24 bg-indigo-50 rounded-full flex items-center justify-center mb-8">
                   <svg className="w-12 h-12 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                </div>
                <h2 className="text-4xl font-black mb-4">The Future of Audiobooks</h2>
                <p className="text-slate-500 text-lg mb-10 max-w-md">Transform any PDF into a cinematic audio experience with AI-driven character separation.</p>
                <label className="cursor-pointer group">
                  <div className="bg-slate-900 text-white px-12 py-5 rounded-2xl font-black text-xl hover:bg-indigo-600 transition-all shadow-xl active:scale-95 group-hover:-translate-y-1">
                    Start Production
                  </div>
                  <input type="file" accept=".pdf" className="hidden" onChange={handleFileUpload} />
                </label>
              </>
            ) : (
              <div className="w-full max-w-md space-y-8 py-4">
                <div className="flex flex-col items-center gap-6">
                  {isAiAnalyzing ? (
                    <div className="relative">
                      <div className="w-20 h-20 bg-indigo-100 rounded-full animate-ping opacity-25"></div>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <svg className="w-10 h-10 text-indigo-600 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      </div>
                    </div>
                  ) : (
                    <div className="w-16 h-16 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                  )}
                  
                  <div className="space-y-2">
                    <h3 className="text-2xl font-black text-slate-900">
                      {isAiAnalyzing ? "AI Casting & Planning" : "Reading Manuscript"}
                    </h3>
                    <p className="text-slate-500 font-medium">
                      {isAiAnalyzing 
                        ? "Gemini is identifying characters and chapters..." 
                        : `Processing page ${extractionProgress.current} of ${extractionProgress.total}`}
                    </p>
                  </div>
                </div>

                {!isAiAnalyzing && extractionProgress.total > 0 && (
                  <div className="space-y-3">
                    <div className="w-full h-4 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
                      <div 
                        className="h-full bg-indigo-600 transition-all duration-300 ease-out shadow-sm"
                        style={{ width: `${(extractionProgress.current / extractionProgress.total) * 100}%` }}
                      ></div>
                    </div>
                    <div className="flex justify-between text-xs font-black text-slate-400 uppercase tracking-widest">
                      <span>Extraction</span>
                      <span>{Math.round((extractionProgress.current / extractionProgress.total) * 100)}%</span>
                    </div>
                  </div>
                )}
                
                {isAiAnalyzing && (
                  <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 text-indigo-700 text-sm font-bold animate-pulse">
                    The model is analyzing the narrative structure. This may take up to a minute for larger books.
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}

        {state.currentStep === 'configuring' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 animate-in fade-in duration-700">
            <div className="lg:col-span-2 space-y-8">
              <div className="bg-white rounded-3xl p-8 shadow-sm border border-slate-100">
                 <h3 className="text-2xl font-black mb-6">Character Voice Casting</h3>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {state.characters.map(char => (
                      <div key={char.id} className="p-6 bg-slate-50 rounded-2xl border border-slate-200 hover:border-indigo-200 transition-all">
                        <div className="flex justify-between items-start mb-2">
                           <span className="font-black text-slate-800">{char.name}</span>
                        </div>
                        <p className="text-sm text-slate-500 mb-4 h-12 overflow-hidden italic line-clamp-2">"{char.description}"</p>
                        <select 
                          className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-bold focus:ring-2 focus:ring-indigo-600"
                          value={char.voiceName}
                          onChange={(e) => {
                            const updated = state.characters.map(c => c.id === char.id ? { ...c, voiceName: e.target.value } : c);
                            setState(prev => ({ ...prev, characters: updated }));
                          }}
                        >
                          {PREBUILT_VOICES.map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </div>
                    ))}
                 </div>
              </div>
            </div>
            <div className="bg-slate-900 rounded-3xl p-8 shadow-2xl text-white flex flex-col justify-between">
               <div>
                  <h4 className="text-xl font-black mb-2">Book Ready</h4>
                  <p className="text-slate-400 text-sm mb-6">{state.chapters.length} chapters identified. Proceed to start audio production.</p>
                  <div className="space-y-3">
                     {state.chapters.map(ch => (
                        <div key={ch.id} className="flex items-center gap-3 text-sm font-medium text-slate-300">
                           <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full"></div>
                           {ch.title}
                        </div>
                     ))}
                  </div>
               </div>
               <button 
                onClick={() => setState(prev => ({ ...prev, currentStep: 'production' }))}
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black py-5 rounded-2xl mt-12 transition-all shadow-lg active:scale-95"
               >
                 Go to Production
               </button>
            </div>
          </div>
        )}

        {(state.currentStep === 'production' || state.currentStep === 'playing') && (
          <div className="flex flex-col lg:flex-row gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="w-full lg:w-96 space-y-6">
               <h3 className="text-2xl font-black">Chapters</h3>
               <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2 custom-scrollbar">
                  {state.chapters.map(ch => (
                    <div key={ch.id} className={`p-5 rounded-3xl border-2 transition-all ${currentChapterId === ch.id ? 'bg-white border-indigo-600 shadow-lg' : 'bg-white border-transparent hover:border-slate-200'}`}>
                       <div className="flex justify-between items-start mb-4">
                          <div className="flex-1 mr-2">
                             <h4 className="font-black text-slate-900 leading-tight">{ch.title}</h4>
                             <p className="text-xs text-slate-400 mt-1 uppercase tracking-widest font-bold">
                               {ch.isComplete ? 'Ready' : ch.isProcessing ? `Synthesizing ${ch.progress}%` : 'Pending'}
                             </p>
                          </div>
                          {ch.isComplete && (
                             <button onClick={() => downloadChapter(ch.id)} className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center text-slate-600 hover:bg-indigo-600 hover:text-white transition-all">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                             </button>
                          )}
                       </div>
                       
                       <div className="flex gap-2">
                          {!ch.isComplete && !ch.isProcessing && (
                             <button 
                              onClick={() => produceChapter(ch.id)}
                              className="flex-1 bg-indigo-600 text-white py-2 rounded-xl text-xs font-black shadow-md hover:bg-indigo-700"
                             >
                               Produce Audio
                             </button>
                          )}
                          {ch.isComplete && (
                             <button 
                              onClick={() => {
                                 setState(prev => ({ ...prev, currentStep: 'playing' }));
                                 playChapter(ch.id);
                              }}
                              className="flex-1 bg-slate-900 text-white py-2 rounded-xl text-xs font-black hover:bg-indigo-600 transition-all"
                             >
                               Play Chapter
                             </button>
                          )}
                          {ch.isProcessing && (
                             <div className="flex-1 h-8 bg-slate-100 rounded-xl overflow-hidden relative">
                                <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${ch.progress}%` }}></div>
                             </div>
                          )}
                       </div>
                    </div>
                  ))}
               </div>
            </div>

            <div className="flex-1 bg-white rounded-[40px] shadow-sm border border-slate-100 flex flex-col min-h-[600px] overflow-hidden">
               {state.currentStep === 'production' && !currentChapterId && (
                  <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
                     <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-6 text-slate-300">
                        <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                     </div>
                     <h3 className="text-2xl font-black text-slate-800">Production Studio</h3>
                     <p className="text-slate-500 max-w-sm mt-2">Select a chapter on the left to start synthesizing its audio or listen to completed recordings.</p>
                  </div>
               )}

               {currentChapterId && (
                  <>
                     <div className="p-8 border-b border-slate-50 flex justify-between items-center bg-slate-50/50">
                        <div>
                           <h3 className="text-xl font-black text-slate-900">{state.chapters.find(c => c.id === currentChapterId)?.title}</h3>
                           <p className="text-sm font-bold text-slate-400">Master Production View</p>
                        </div>
                        <div className="flex gap-4">
                           <button 
                            onClick={() => setIsPlaying(!isPlaying)}
                            className={`w-12 h-12 rounded-full flex items-center justify-center text-white transition-all shadow-lg ${isPlaying ? 'bg-amber-500 scale-105' : 'bg-indigo-600 hover:bg-indigo-700'}`}
                           >
                             {isPlaying ? (
                               <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                             ) : (
                               <svg className="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" /></svg>
                             )}
                           </button>
                        </div>
                     </div>
                     <div className="flex-1 overflow-y-auto p-8 space-y-4 custom-scrollbar">
                        {state.chapters.find(c => c.id === currentChapterId)?.segments.map((seg, idx) => (
                           <div 
                              key={idx}
                              ref={currentSegmentIndex === idx ? activeSegmentRef : null}
                              className={`p-6 rounded-2xl transition-all border-2 ${currentSegmentIndex === idx ? 'bg-indigo-600 border-indigo-600 shadow-xl' : 'bg-white border-slate-50'}`}
                           >
                              <div className="flex justify-between items-center mb-2">
                                 <span className={`text-[10px] font-black uppercase tracking-widest ${currentSegmentIndex === idx ? 'text-indigo-100' : 'text-indigo-600'}`}>
                                    {seg.speakerId}
                                 </span>
                              </div>
                              <p className={`text-lg leading-relaxed ${currentSegmentIndex === idx ? 'text-white font-medium' : 'text-slate-800'}`}>
                                 {seg.text}
                              </p>
                           </div>
                        ))}
                     </div>
                  </>
               )}
            </div>
          </div>
        )}
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
      `}</style>
    </div>
  );
};

export default App;
