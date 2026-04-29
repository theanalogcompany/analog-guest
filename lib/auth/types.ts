export class AuthError extends Error {
  readonly status: 401 | 403

  constructor(status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

export interface AuthenticatedOperator {
  operatorId: string
  allowedVenueIds: string[]
}
