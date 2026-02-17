export type UserNoteCandidate = {
  noteKey: string;
  content: string;
  tags?: string[];
};

function cleanValue(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/g, "");
}

function titleCaseWords(value: string) {
  return value
    .split(/\s+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
    .join(" ");
}

function isLikelySensitive(value: string) {
  if (/\b(api[_ -]?key|token|password|secret)\b/i.test(value)) return true;
  if (/sk-[a-z0-9-]{12,}/i.test(value)) return true;
  if (/[A-Za-z0-9+/_-]{32,}/.test(value)) return true;
  return false;
}

export function extractUserMemoryNotes(message: string): UserNoteCandidate[] {
  const text = message.trim();
  if (!text || text.length > 800) return [];
  if (isLikelySensitive(text)) return [];

  const candidates: UserNoteCandidate[] = [];

  const preferMatch = text.match(
    /\b(?:i|we)\s+(?:really\s+|generally\s+)?(?:prefer|like)\s+([a-z0-9+#.\- ][a-z0-9+#.\- ]{1,40})\b/i
  );
  if (preferMatch) {
    const preference = cleanValue(preferMatch[1]);
    if (preference.length >= 2) {
      candidates.push({
        noteKey: "preference.general",
        content: `User preference: ${preference}.`,
        tags: ["preference"]
      });
    }
  }

  const techPreferMatch = text.match(
    /\b(?:i|we)\s+(?:prefer|like|use)\s+(php|python|typescript|javascript|go|rust|java|c#|c\+\+)\b/i
  );
  if (techPreferMatch) {
    const language = cleanValue(techPreferMatch[1]).toUpperCase();
    candidates.push({
      noteKey: "preference.language",
      content: `Preferred language: ${language}.`,
      tags: ["preference", "tech"]
    });
  }

  const locationMatch = text.match(
    /\b(?:i(?:'m| am)\s+(?:based|located)\s+in|i\s+live\s+in)\s+([a-z][a-z .'-]{1,40})\b/i
  );
  if (locationMatch) {
    const location = titleCaseWords(cleanValue(locationMatch[1]));
    if (location.length >= 2) {
      candidates.push({
        noteKey: "profile.location",
        content: `Location: ${location}.`,
        tags: ["profile", "location"]
      });
    }
  }

  const nameMatch = text.match(/\bmy\s+name\s+is\s+([a-z][a-z .'-]{1,40})\b/i);
  if (nameMatch) {
    const name = titleCaseWords(cleanValue(nameMatch[1]));
    if (name.length >= 2) {
      candidates.push({
        noteKey: "profile.name",
        content: `Name: ${name}.`,
        tags: ["profile"]
      });
    }
  }

  const unique = new Map<string, UserNoteCandidate>();
  for (const candidate of candidates) {
    unique.set(candidate.noteKey, candidate);
  }
  return Array.from(unique.values()).slice(0, 3);
}
