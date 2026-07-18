export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type RunCommand = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<CommandResult>;

export type PublishReleaseOptions = {
  root?: string;
  tag: string;
  repository: string;
  commit: string;
  runCommand?: RunCommand;
  sleep?: (delay: number) => Promise<void>;
  delaysMs?: number[];
};

export type PublishReleaseResult = {
  package: string;
  version: string;
  tag: string;
  commit: string;
  tarball: string;
  integrity: string;
  published: boolean;
  registryVerified: true;
};

export function publishRelease(options: PublishReleaseOptions): Promise<PublishReleaseResult>;
