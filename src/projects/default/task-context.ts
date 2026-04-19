// Extend this file to provide structured context to scheduled tasks for the default project.
// Return a string to inject into the agent prompt, or null to use the raw task prompt.
export async function buildDefaultTaskContext(_taskId: string): Promise<string | null> {
  return null
}
