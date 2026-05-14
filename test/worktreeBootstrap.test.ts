import { describe, it, expect } from 'vitest';
import { substituteTemplate } from '../src/worktrees/service';

describe('substituteTemplate', () => {
  const vars = {
    new_branch: 'feat/x',
    worktree_path: '/tmp/wt',
    base_branch: 'main',
  };

  it('substitutes known placeholders', () => {
    expect(
      substituteTemplate(
        'echo {new_branch} at {worktree_path} from {base_branch}',
        vars
      )
    ).toBe('echo feat/x at /tmp/wt from main');
  });

  it('repeats and orders placeholders independently', () => {
    expect(
      substituteTemplate('{base_branch}/{new_branch}/{new_branch}', vars)
    ).toBe('main/feat/x/feat/x');
  });

  it('leaves unknown placeholders intact', () => {
    expect(substituteTemplate('hi {unknown} {new_branch}', vars)).toBe(
      'hi {unknown} feat/x'
    );
  });

  it('treats {{ and }} as literal braces', () => {
    expect(substituteTemplate('{{not_a_var}} {new_branch}', vars)).toBe(
      '{not_a_var} feat/x'
    );
  });

  it('returns the input unchanged when there are no placeholders', () => {
    expect(substituteTemplate('npm install', vars)).toBe('npm install');
  });

  it('handles empty template', () => {
    expect(substituteTemplate('', vars)).toBe('');
  });
});
