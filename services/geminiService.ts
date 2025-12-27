
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { Character, ScriptSegment, Chapter, PREBUILT_VOICES } from "../types";
import { decode, decodeAudioData } from "../utils/audioUtils";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Utility function to handle API calls with exponential backoff for rate limiting (429 errors)
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5, baseDelay = 1000): Promise<T> {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      // Check if it's a rate limit error (429)
      const isRateLimit = error?.message?.includes('429') || error?.status === 429 || JSON.stringify(error).includes('429');
      
      if (isRateLimit && i < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, i) + Math.random() * 1000;
        console.warn(`Rate limit hit (429). Retrying in ${Math.round(delay)}ms... (Attempt ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function identifyChaptersAndCharacters(text: string): Promise<{ chapters: Partial<Chapter>[], characters: Character[] }> {
  const analysisText = text.substring(0, 60000);

  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Analyze this book text.
      1. List all main characters and descriptions.
      2. Identify logical chapter breaks in the text. Return the titles and starting text snippets for each chapter found.
      
      TEXT:
      ${analysisText}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            characters: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING },
                  description: { type: Type.STRING }
                },
                required: ["id", "name", "description"]
              }
            },
            chapters: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  startSnippet: { type: Type.STRING }
                },
                required: ["title", "startSnippet"]
              }
            }
          },
          required: ["characters", "chapters"]
        }
      }
    });

    const data = JSON.parse(response.text || '{}');
    
    const characters: Character[] = data.characters.map((c: any, index: number) => ({
      ...c,
      voiceName: PREBUILT_VOICES[index % PREBUILT_VOICES.length]
    }));

    if (!characters.find(c => c.name.toLowerCase() === 'narrator')) {
      characters.push({ id: 'Narrator', name: 'Narrator', description: 'The story teller', voiceName: 'charon' });
    }

    const chapters: Partial<Chapter>[] = [];
    let lastIndex = 0;
    
    for (let i = 0; i < data.chapters.length; i++) {
      const chapData = data.chapters[i];
      const nextChapData = data.chapters[i + 1];
      
      const startIndex = text.indexOf(chapData.startSnippet, lastIndex);
      const endIndex = nextChapData ? text.indexOf(nextChapData.startSnippet, startIndex + 1) : text.length;
      
      if (startIndex !== -1) {
        chapters.push({
          id: `ch-${i}`,
          title: chapData.title,
          content: text.substring(startIndex, endIndex),
          segments: [],
          isProcessing: false,
          isComplete: false,
          progress: 0
        });
        lastIndex = startIndex;
      }
    }

    if (chapters.length === 0) {
      chapters.push({
        id: 'ch-0',
        title: 'Full Content',
        content: text,
        segments: [],
        isProcessing: false,
        isComplete: false,
        progress: 0
      });
    }

    return { chapters, characters };
  });
}

export async function generateChapterScript(chapterContent: string): Promise<ScriptSegment[]> {
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Convert this chapter text into a script. Identify speakers and narrator.
      
      TEXT:
      ${chapterContent.substring(0, 30000)}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              speakerId: { type: Type.STRING },
              text: { type: Type.STRING }
            },
            required: ["speakerId", "text"]
          }
        }
      }
    });

    return JSON.parse(response.text || '[]');
  });
}

export async function generateSpeech(text: string, voiceName: string, audioCtx: AudioContext): Promise<AudioBuffer> {
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voiceName.toLowerCase() },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("No audio data received");

    return await decodeAudioData(decode(base64Audio), audioCtx, 24000, 1);
  });
}
