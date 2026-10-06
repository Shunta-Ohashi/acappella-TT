import type { Member, MemberId } from '../domain/models.ts'

export type MemberResolution =
  | { ok: true; memberId: MemberId }
  | { ok: false; message: string }

export const getCsvMemberName = (
  member: Pick<Member, 'realName'> | undefined,
): string => member?.realName ?? ''

export const resolveMemberId = (
  idValue: string,
  nameValue: string,
  members: Member[],
): MemberResolution => {
  const id = idValue.trim()
  if (id) {
    return members.some((member) => member.id === id)
      ? { ok: true, memberId: id }
      : { ok: false, message: `メンバーID「${id}」が見つかりません。` }
  }

  const name = nameValue.trim()
  if (!name) return { ok: false, message: 'メンバーIDまたは名前を入力してください。' }
  const realNameMatches = members.filter((member) => member.realName.trim() === name)
  if (realNameMatches.length === 1) {
    return { ok: true, memberId: realNameMatches[0].id }
  }
  if (realNameMatches.length > 1) {
    return { ok: false, message: `本名「${name}」に一致するメンバーが複数います。` }
  }
  const acaNameMatches = members.filter((member) => member.acaName?.trim() === name)
  if (acaNameMatches.length === 1) {
    return { ok: true, memberId: acaNameMatches[0].id }
  }
  if (acaNameMatches.length > 1) {
    return { ok: false, message: `アカペラネーム「${name}」に一致するメンバーが複数います。` }
  }
  return {
    ok: false,
    message: `メンバー「${name}」が見つかりません。先に共通データへ登録してください。`,
  }
}

export const resolveMemberFromColumns = (
  idValue: string,
  realNameValue: string,
  acaNameValue: string,
  members: Member[],
): MemberResolution => {
  if (idValue.trim()) return resolveMemberId(idValue, '', members)

  const realName = realNameValue.trim()
  if (realName) {
    const matches = members.filter((member) => member.realName.trim() === realName)
    if (matches.length === 1) return { ok: true, memberId: matches[0].id }
    if (matches.length > 1) {
      return { ok: false, message: `本名「${realName}」に一致するメンバーが複数います。` }
    }
  }

  const acaName = acaNameValue.trim()
  if (acaName) {
    const matches = members.filter((member) => member.acaName?.trim() === acaName)
    if (matches.length === 1) return { ok: true, memberId: matches[0].id }
    if (matches.length > 1) {
      return { ok: false, message: `アカペラネーム「${acaName}」に一致するメンバーが複数います。` }
    }
  }

  const label = realName || acaName
  return {
    ok: false,
    message: label
      ? `メンバー「${label}」が見つかりません。先に共通データへ登録してください。`
      : 'メンバーIDまたは名前を入力してください。',
  }
}

export const resolveMemberList = (
  idValues: string[],
  nameValues: string[],
  members: Member[],
): { ok: true; memberIds: MemberId[] } | { ok: false; message: string } => {
  const resolved: MemberId[] = []
  const source = idValues.length > 0 ? idValues : nameValues
  for (const value of source) {
    const result = resolveMemberId(idValues.length > 0 ? value : '', value, members)
    if (!result.ok) return result
    resolved.push(result.memberId)
  }
  if (new Set(resolved).size !== resolved.length) {
    return { ok: false, message: '同じメンバーが複数回指定されています。' }
  }
  return { ok: true, memberIds: resolved }
}

