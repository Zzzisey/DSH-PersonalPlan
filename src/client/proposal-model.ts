export interface ProposalAccess {
  proposalId: string
  token: string
}

export function proposalAccessKey(access: ProposalAccess): string {
  return `${access.proposalId}:${access.token}`
}
