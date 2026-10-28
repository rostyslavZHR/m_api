export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

export function buildProblem(
  status: number,
  detail: string,
  instance: string,
): Problem {
  const { type, title } = problemInfo(status);
  return { type, title, status, detail, instance };
}

// `type` (RFC 9457) names the kind of error so clients can branch on it, not on
// `detail`. It's an identifier, not a link clients fetch; example.com is a placeholder.
function problemInfo(status: number): { type: string; title: string } {
  if (status === 404) {
    return {
      type: 'https://example.com/problems/not-found',
      title: 'Not Found',
    };
  }
  if (status === 409) {
    return { type: 'https://example.com/problems/conflict', title: 'Conflict' };
  }
  if (status >= 400 && status < 500) {
    return {
      type: 'https://example.com/problems/validation-error',
      title: 'Validation Error',
    };
  }
  return {
    type: 'https://example.com/problems/internal-error',
    title: 'Internal Server Error',
  };
}
