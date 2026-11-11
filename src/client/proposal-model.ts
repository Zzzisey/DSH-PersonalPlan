export interface ProposalAccess {
  proposalId: string
  token: string
  revision: number
}

export function proposalAccessFromUrl(search: string): ProposalAccess | null {
  const params = new URLSearchParams(search)
  const proposalId = params.get('proposal')
  const token = params.get('token')
  const revision = Number(params.get('revision'))
  return proposalId === null || proposalId === '' || token === null || token === '' || !Number.isInteger(revision) || revision < 0
    ? null
    : { proposalId, token, revision }
}
