import { AbstractLogger, type LogLevel, type LogMessage } from 'typeorm';

type RawLogMessage = LogMessage | string | number | (LogMessage | string | number)[];

// Counts every SQL statement TypeORM sends. N+1 is invisible in the code —
// only the log or a counter shows it.
export class QueryCountLogger extends AbstractLogger {
  queryCount = 0;
  /** Print each counted statement: shortened to one line, or in full with its parameters. */
  echo: 'off' | 'short' | 'full' = 'off';

  reset() {
    this.queryCount = 0;
  }

  protected writeLog(_level: LogLevel, message: RawLogMessage) {
    for (const logMessage of this.prepareLogMessages(message)) {
      if (logMessage.type !== 'query') continue;
      this.queryCount += 1;
      this.print(logMessage);
    }
  }

  private print(logMessage: LogMessage) {
    const sql = String(logMessage.message);
    const label = `SQL#${this.queryCount}`;

    if (this.echo === 'short') {
      console.log(`    ${label}: ${sql.replace(/\s+/g, ' ').slice(0, 110)}`);
    } else if (this.echo === 'full') {
      console.log(`\n    ${label}:\n${sql}`);
      const { parameters } = logMessage;
      if (parameters && Object.keys(parameters).length) {
        console.log(`    -- PARAMETERS: ${JSON.stringify(parameters)}`);
      }
    }
  }
}
