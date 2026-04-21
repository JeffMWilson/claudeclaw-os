import { describe, it, expect } from 'vitest';

import { isAudioAttachmentDescriptor, splitDiscordMessage } from './discord.js';

describe('isAudioAttachmentDescriptor', () => {
  it('returns true for audio/* content types', () => {
    expect(isAudioAttachmentDescriptor('audio/mpeg', 'note.txt')).toBe(true);
    expect(isAudioAttachmentDescriptor('Audio/OGG', null)).toBe(true);
  });

  it('falls back to extension when content type is missing', () => {
    expect(isAudioAttachmentDescriptor(undefined, 'voice.ogg')).toBe(true);
    expect(isAudioAttachmentDescriptor(null, 'recording.M4A')).toBe(true);
  });

  it('returns true for known audio extension even when content type is non-audio', () => {
    expect(isAudioAttachmentDescriptor('application/octet-stream', 'clip.webm')).toBe(true);
  });

  it('returns false for non-audio content and extension', () => {
    expect(isAudioAttachmentDescriptor('image/png', 'photo.png')).toBe(false);
    expect(isAudioAttachmentDescriptor(undefined, undefined)).toBe(false);
  });
});

describe('splitDiscordMessage', () => {
  it('returns a single part when under the limit', () => {
    expect(splitDiscordMessage('hello', 10)).toEqual(['hello']);
  });

  it('returns a single part when exactly at the limit', () => {
    const text = 'x'.repeat(10);
    expect(splitDiscordMessage(text, 10)).toEqual([text]);
  });

  it('splits at newline near the end of the chunk when possible', () => {
    const text = 'aaaaa\nbbbbb\nccccc';
    const parts = splitDiscordMessage(text, 11);
    expect(parts).toEqual(['aaaaa\nbbbbb', 'ccccc']);
  });

  it('splits at hard limit when no suitable newline exists', () => {
    const text = 'a'.repeat(25);
    const parts = splitDiscordMessage(text, 10);
    expect(parts).toHaveLength(3);
    expect(parts[0].length).toBe(10);
    expect(parts[1].length).toBe(10);
    expect(parts.join('')).toBe(text);
  });

  it('trims leading whitespace from subsequent chunks', () => {
    const text = '1234567890\n   next line';
    const parts = splitDiscordMessage(text, 11);
    expect(parts).toEqual(['1234567890', 'next line']);
  });
});
