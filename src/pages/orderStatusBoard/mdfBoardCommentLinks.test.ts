import { describe, expect, it } from 'vitest';
import {
  collectMdfCommentLinkCandidates,
  extractMdfCommentFileLinks,
  parseMdfLiveComments,
  type MdfCommentLinkCandidate,
} from './mdfBoardCommentLinks';
import type { MdfPublishedCardPresentation } from '../../api/types/mdfPublishedApi.types';

describe('collectMdfCommentLinkCandidates', () => {
  it('collects program/external names of non-stale, fully-visible packets only', () => {
    const presentation: MdfPublishedCardPresentation[] = [
      { kind: 'packet', id: 'p1', stale: false, composition: { items: [], programName: 'File_001.dxf', externalKey: 'EXT-1' }, live: null },
      { kind: 'packet', id: 'p2', stale: true, composition: { items: [], programName: 'Stale.dxf' }, live: null },
      { kind: 'packet', id: 'p3', stale: false, composition: null, live: null },
      { kind: 'bazisCutSet', id: 's1', stale: false, composition: { items: [] }, live: { name: 'BASIS 1' } },
    ];
    expect(collectMdfCommentLinkCandidates(presentation)).toEqual([
      { kind: 'packet', id: 'p1', names: ['File_001.dxf', 'EXT-1'] },
    ]);
  });
});

describe('parseMdfLiveComments', () => {
  it('accepts a string array and drops non-string/blank entries', () => {
    expect(parseMdfLiveComments(['ok', '', 42, null, 'also ok'])).toEqual(['ok', 'also ok']);
  });
  it('returns empty for anything else', () => {
    expect(parseMdfLiveComments(null)).toEqual([]);
    expect(parseMdfLiveComments({ text: 'x' })).toEqual([]);
    expect(parseMdfLiveComments('plain string')).toEqual([]);
  });
});

describe('extractMdfCommentFileLinks', () => {
  const candidates: MdfCommentLinkCandidate[] = [
    { kind: 'packet', id: 'p1', names: ['File_001.dxf'] },
    { kind: 'packet', id: 'p2', names: ['File_00'] },
  ];

  it('turns a matching file name into a link segment', () => {
    const segments = extractMdfCommentFileLinks('см. File_001.dxf, перепилить', candidates);
    expect(segments).toEqual([
      { kind: 'text', text: 'см. ' },
      { kind: 'link', text: 'File_001.dxf', target: { kind: 'packet', id: 'p1' } },
      { kind: 'text', text: ', перепилить' },
    ]);
  });

  it('is case-insensitive', () => {
    const segments = extractMdfCommentFileLinks('file_001.DXF plохо', candidates);
    expect(segments[0]).toEqual({ kind: 'link', text: 'file_001.DXF', target: { kind: 'packet', id: 'p1' } });
  });

  it('leaves unmatched names as plain text', () => {
    const segments = extractMdfCommentFileLinks('какой-то другой файл.dxf', candidates);
    expect(segments).toEqual([{ kind: 'text', text: 'какой-то другой файл.dxf' }]);
  });

  it('prefers the longer candidate name over a shorter substring match', () => {
    const segments = extractMdfCommentFileLinks('File_001.dxf', candidates);
    expect(segments).toEqual([{ kind: 'link', text: 'File_001.dxf', target: { kind: 'packet', id: 'p1' } }]);
  });

  it('returns empty for empty text', () => {
    expect(extractMdfCommentFileLinks('', candidates)).toEqual([]);
  });
});
