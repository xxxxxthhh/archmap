/** In-memory inventory of lendable tools. */

export interface Tool {
  id: string;
  name: string;
  available: boolean;
}

export class Inventory {
  private readonly tools = new Map<string, Tool>();

  add(tool: Tool): void {
    this.tools.set(tool.id, tool);
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  setAvailable(id: string, available: boolean): void {
    const tool = this.tools.get(id);
    if (tool) tool.available = available;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}
