
export interface Character {
  id: string;
  name: string;
  voiceName: string;
  description: string;
}

export interface ScriptSegment {
  speakerId: string;
  text: string;
  audioBuffer?: AudioBuffer;
}

export interface Chapter {
  id: string;
  title: string;
  content: string;
  segments: ScriptSegment[];
  isProcessing: boolean;
  isComplete: boolean;
  progress: number;
}

export interface AudiobookState {
  title: string;
  characters: Character[];
  chapters: Chapter[];
  isProcessing: boolean;
  currentStep: 'upload' | 'analyzing' | 'configuring' | 'production' | 'playing';
}

// Updated with names confirmed by the Gemini API error message
export const PREBUILT_VOICES = [
  'kore', 
  'puck', 
  'charon', 
  'fenrir', 
  'zephyr', 
  'aoede', 
  'leda', 
  'orus', 
  'despina', 
  'gacrux'
];
