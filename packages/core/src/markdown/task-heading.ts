/** Whether a label names the automatic Tasks section, ignoring case and surrounding space. */
export function isTasksLabel(label: string): boolean {
  return label.trim().toLowerCase() === 'tasks'
}
