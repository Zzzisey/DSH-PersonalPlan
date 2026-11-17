export interface ProposalAccess {
  proposalId: string
  token: string
  revision: number
}

export function proposalAccessKey(access: ProposalAccess): string {
  return `${access.proposalId}:${access.revision}:${access.token}`
}
