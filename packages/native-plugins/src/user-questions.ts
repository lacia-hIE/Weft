import type {AskUserQuestionAnswer, AskUserQuestionItem} from '@deepseek-ai/dsh-user-questions/types';

/** Native request identity for a live waterfall, or the call id of a continued question. */
export interface HostUserQuestion {
  requestId: string;
  callId?: string;
  state: 'open' | 'continued';
  questions: readonly AskUserQuestionItem[];
}

/** Only ordinary questions are admitted by the IM-capable bridge; approval stays with its own UI. */
export function conversationalQuestions(questions: readonly AskUserQuestionItem[]): boolean {
  return questions.length > 0 && questions.every(question => question.intent?.kind !== 'approval');
}

/** Validate against the actual offered questions before a client can settle the native request. */
export function validateQuestionAnswer(questions: readonly AskUserQuestionItem[], answer: AskUserQuestionAnswer): void {
  const ids = new Set(answer.answers.map(item => item.id));
  if (ids.size !== answer.answers.length || questions.length !== ids.size || questions.some(question => !ids.has(question.id)))
    throw new TypeError('Answer each question exactly once');
  for (const question of questions) {
    const item = answer.answers.find(item => item.id === question.id)!;
    if (new Set(item.selected).size !== item.selected.length || (!question.multiSelect && item.selected.length > 1)
      || item.selected.some(label => !question.options?.some(option => option.label === label)))
      throw new TypeError('Answer must use offered options or custom text');
  }
}
