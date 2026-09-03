/**
 * The service this MCP server owns: a per-user notes store. In-memory, so it
 * resets on restart — swap for a real database (or a Redis knowledge store) for
 * anything beyond a demo. The point is that every note is scoped to the
 * authenticated user, so tools only ever see the caller's own data.
 */
import { randomUUID } from "node:crypto";

export interface Note {
  id: string;
  text: string;
  createdAt: string;
}

const notesByUser = new Map<string, Note[]>();

export function listNotes(userId: string): Note[] {
  return notesByUser.get(userId) ?? [];
}

export function addNote(userId: string, text: string): Note {
  const note: Note = { id: randomUUID(), text, createdAt: new Date().toISOString() };
  const notes = notesByUser.get(userId) ?? [];
  notes.push(note);
  notesByUser.set(userId, notes);
  return note;
}

export function deleteNote(userId: string, id: string): boolean {
  const notes = notesByUser.get(userId);
  if (!notes) return false;
  const index = notes.findIndex((n) => n.id === id);
  if (index < 0) return false;
  notes.splice(index, 1);
  return true;
}
