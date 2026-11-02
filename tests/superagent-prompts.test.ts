import assert from 'node:assert/strict';
import {test} from 'node:test';
import {githubSkill, promptFiles} from '../plugins/superagent/scripts/embed-prompts.mjs';
import {GITHUB_SKILL, PROMPT_FILES} from '../plugins/superagent/src/app/prompt-files.ts';

test('the embedded prompts are the ones under prompts/ and skills/; run scripts/embed-prompts.mjs after an edit', () => {
  assert.deepEqual(PROMPT_FILES, promptFiles());
  assert.equal(GITHUB_SKILL, githubSkill());
});
