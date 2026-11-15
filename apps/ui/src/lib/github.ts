export interface GitHubAccount {
  connected: boolean;
  login: string | null;
  pending: {
    id: string;
    status: string;
    userCode?: string;
    verificationUri?: string;
    error: string | null;
  } | null;
}
