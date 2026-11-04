import type {SourceType} from '../sources/types.ts'
import type {T} from './text.ts'
export const connectionTypes: {id: SourceType; zh: string; en: string; mark: string}[] = [
  {id: 'github-webhook', zh: 'GitHub', en: 'GitHub', mark: 'GH'},
  {id: 'gitlab', zh: 'GitLab', en: 'GitLab', mark: 'GL'},
  {id: 'feed', zh: 'RSS / Atom', en: 'RSS / Atom', mark: 'RSS'},
  {id: 'feishu', zh: '飞书', en: 'Feishu', mark: '飞'},
  {id: 'weixin', zh: '微信', en: 'WeChat', mark: '微'},
  {id: 'qq', zh: 'QQ', en: 'QQ', mark: 'QQ'},
  {id: 'email', zh: '邮箱', en: 'Email', mark: '@'},
]
export function connectionType(t: T, kind: string) {
  const type = connectionTypes.find(row => row.id === (kind === 'github' ? 'github-webhook' : kind))
  return type ? t('lang') === 'zh' ? type.zh : type.en : t('sourceBuiltin')
}
