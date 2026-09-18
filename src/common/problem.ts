export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

export function buildProblem(status: number, detail: string, instance: string): Problem {
  const { type, title } = problemInfo(status);
  return { type, title, status, detail, instance };
}

function problemInfo(status: number): { type: string; title: string } {
  if (status === 404) {
    return { type: 'https://example.com/problems/not-found', title: 'Not Found' };
  }
  if (status >= 400 && status < 500) {
    return { type: 'https://example.com/problems/validation-error', title: 'Validation Error' };
  }
  return { type: 'https://example.com/problems/internal-error', title: 'Internal Server Error' };
}
