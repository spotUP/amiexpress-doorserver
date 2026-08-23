/**
 * AmigaGuide Parser
 *
 * COPIED, not rewritten, from amiexpress-web:
 * web/backend/src/amigaguide/AmigaGuideParser.ts - the BBS has parsed these
 * files for years and this is the same parser, so a door's documentation
 * reads the same on the web as it does on the board. Keep the two in step:
 * a fix to either belongs in both.
 *
 * Parses and renders AmigaGuide (.guide) hypertext documentation files.
 *
 * AmigaGuide is a hypertext system for the Amiga, similar to Windows .hlp files.
 * It uses a simple markup language with @-commands and inline formatting.
 *
 * Format Reference: https://wiki.amigaos.net/wiki/AmigaGuide_101
 */

export interface AmigaGuideNode {
  name: string;
  title: string;
  content: string;
  links: AmigaGuideLink[];
  prev?: string;
  next?: string;
  toc?: string;
  index?: string;
  help?: string;
}

export interface AmigaGuideLink {
  text: string;
  target: string;
  line: number;
  index: number; // Link number for keyboard navigation
}

export interface AmigaGuideDocument {
  database: string;
  author?: string;
  version?: string;
  copyright?: string;
  nodes: Map<string, AmigaGuideNode>;
  mainNode: string;
  masterNode?: string;
}

export class AmigaGuideParser {
  private document: AmigaGuideDocument;
  private currentNode: string = '';

  constructor() {
    this.document = {
      database: 'AmigaGuide Document',
      nodes: new Map(),
      mainNode: 'main'
    };
  }

  /**
   * Parse an AmigaGuide file from text content
   */
  public parse(content: string): AmigaGuideDocument {
    const lines = content.split(/\r?\n/);

    let inNode = false;
    let currentNode: Partial<AmigaGuideNode> = {};
    let nodeContent: string[] = [];
    let linkIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Handle @-commands
      if (trimmed.startsWith('@')) {
        const command = this.parseCommand(trimmed);

        switch (command.name) {
          case 'database':
            this.document.database = command.args[0] || 'AmigaGuide Document';
            break;

          case 'author':
            this.document.author = command.args.join(' ');
            break;

          case 'version':
            this.document.version = command.args.join(' ');
            break;

          case 'copyright':
            this.document.copyright = command.args.join(' ');
            break;

          case 'master':
            this.document.masterNode = command.args[0];
            break;

          case 'node':
            // Save previous node if exists
            if (inNode && currentNode.name) {
              this.saveNode(currentNode, nodeContent.join('\n'), linkIndex);
            }

            // Start new node
            inNode = true;
            currentNode = {
              name: command.args[0] || 'unnamed',
              title: command.args.slice(1).join(' ') || command.args[0] || 'Untitled',
              links: []
            };
            nodeContent = [];
            linkIndex = 0;

            // Set main node if this is the first node or named "main"
            if (!this.document.nodes.size || (currentNode.name && currentNode.name.toLowerCase() === 'main')) {
              this.document.mainNode = currentNode.name || '';
            }
            break;

          case 'endnode':
            if (inNode && currentNode.name) {
              this.saveNode(currentNode, nodeContent.join('\n'), linkIndex);
              inNode = false;
              currentNode = {};
              nodeContent = [];
            }
            break;

          case 'prev':
            if (currentNode) currentNode.prev = command.args[0];
            break;

          case 'next':
            if (currentNode) currentNode.next = command.args[0];
            break;

          case 'toc':
            if (currentNode) currentNode.toc = command.args[0];
            break;

          case 'index':
            if (currentNode) currentNode.index = command.args[0];
            break;

          case 'help':
            if (currentNode) currentNode.help = command.args[0];
            break;

          case 'wordwrap':
          case 'tab':
          case 'width':
          case 'height':
            // Formatting commands - ignore for now
            break;

          default:
            // Unknown command - treat as content
            if (inNode) {
              nodeContent.push(line);
            }
        }
      } else {
        // Regular content line
        if (inNode) {
          nodeContent.push(line);
        }
      }
    }

    // Save last node
    if (inNode && currentNode.name) {
      this.saveNode(currentNode, nodeContent.join('\n'), linkIndex);
    }

    return this.document;
  }

  /**
   * Parse a single @-command
   */
  private parseCommand(line: string): { name: string; args: string[] } {
    const match = line.match(/@(\w+)\s*(.*)/);
    if (!match) {
      return { name: '', args: [] };
    }

    const name = match[1].toLowerCase();
    const argsStr = match[2].trim();

    // Parse quoted arguments
    const args: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < argsStr.length; i++) {
      const char = argsStr[i];

      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ' ' && !inQuotes) {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      args.push(current);
    }

    return { name, args };
  }

  /**
   * Save a parsed node
   */
  private saveNode(node: Partial<AmigaGuideNode>, content: string, linkIndex: number): void {
    if (!node.name) return;

    // Parse inline links in content
    const links = this.parseLinks(content);

    const fullNode: AmigaGuideNode = {
      name: node.name,
      title: node.title || node.name,
      content: content,
      links: links,
      prev: node.prev,
      next: node.next,
      toc: node.toc,
      index: node.index,
      help: node.help
    };

    this.document.nodes.set(node.name, fullNode);
  }

  /**
   * Parse inline links from content
   */
  private parseLinks(content: string): AmigaGuideLink[] {
    const links: AmigaGuideLink[] = [];
    const lines = content.split('\n');
    let linkIndex = 1;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      // Match @{<text> link <target>} or @{<text> link <target> <line>}
      const linkRegex = /@\{([^}]+)\s+link\s+([^}\s]+)(?:\s+\d+)?\}/gi;
      let match;

      while ((match = linkRegex.exec(line)) !== null) {
        links.push({
          text: match[1].trim().replace(/^["']|["']$/g, ''),
          target: match[2].trim(),
          line: lineNum,
          index: linkIndex++
        });
      }

      // Also match simple @{<target>} format
      const simpleRegex = /@\{([^}\s]+)\}/g;
      while ((match = simpleRegex.exec(line)) !== null) {
        // Skip if it's a formatting command
        const text = match[1];
        if (!['b', 'u', 'i', 'ub', 'ui', 'bg', 'fg', 'jleft', 'jright', 'jcenter'].includes(text.toLowerCase())) {
          links.push({
            text: text,
            target: text,
            line: lineNum,
            index: linkIndex++
          });
        }
      }
    }

    return links;
  }

  /**
   * Render a node as ANSI text with link markers
   */
  public renderNode(nodeName: string, width: number = 80, maxLines: number = 20, scrollOffset: number = 0): {
    lines: string[];
    totalLines: number;
    links: AmigaGuideLink[];
    hasMore: boolean;
  } {
    const node = this.document.nodes.get(nodeName);

    if (!node) {
      return {
        lines: [`Node "${nodeName}" not found.`],
        totalLines: 1,
        links: [],
        hasMore: false
      };
    }

    // Render content with formatting
    const rendered = this.renderContent(node.content, width);
    const totalLines = rendered.length;

    // Apply scroll offset
    const visibleLines = rendered.slice(scrollOffset, scrollOffset + maxLines);
    const hasMore = scrollOffset + maxLines < totalLines;

    return {
      lines: visibleLines,
      totalLines,
      links: node.links,
      hasMore
    };
  }

  /**
   * Render content with inline formatting
   */
  private renderContent(content: string, width: number): string[] {
    const lines: string[] = [];
    const rawLines = content.split('\n');

    for (let line of rawLines) {
      // Process inline formatting
      line = this.processInlineFormatting(line);

      // Wrap long lines
      const wrapped = this.wrapLine(line, width);
      lines.push(...wrapped);
    }

    return lines;
  }

  /**
   * Process inline formatting codes
   */
  private processInlineFormatting(line: string): string {
    // Replace AmigaGuide formatting with ANSI codes

    // Bold: @{b} text @{ub} - strip bold tags (Amiga BBS doesn't use bold)
    line = line.replace(/@\{b\}/gi, '');
    line = line.replace(/@\{ub\}/gi, '');

    // Underline: @{u} text @{uu}
    line = line.replace(/@\{u\}/gi, '\x1b[4m');
    line = line.replace(/@\{uu\}/gi, '\x1b[24m');

    // Italic: @{i} text @{ui}
    line = line.replace(/@\{i\}/gi, '\x1b[3m');
    line = line.replace(/@\{ui\}/gi, '\x1b[23m');

    // Links: @{"text" link target} -> [n] text  (strip surrounding quotes)
    let linkNum = 1;
    line = line.replace(/@\{([^}]+)\s+link\s+([^}\s]+)(?:\s+\d+)?\}/gi, (match, text) => {
      const clean = text.trim().replace(/^["']|["']$/g, '');
      return `\x1b[36m[${linkNum++}]\x1b[0m \x1b[33m${clean}\x1b[0m`;
    });

    // Simple links: @{target}
    line = line.replace(/@\{([^}\s]+)\}/g, (match, target) => {
      // Skip formatting commands
      if (['b', 'u', 'i', 'ub', 'ui', 'uu', 'bg', 'fg'].includes(target.toLowerCase())) {
        return match;
      }
      return `\x1b[36m[${linkNum++}]\x1b[0m \x1b[33m${target}\x1b[0m`;
    });

    // Colors: @{fg <color>} and @{bg <color>}
    line = line.replace(/@\{fg\s+(\w+)\}/gi, ''); // Ignore for now
    line = line.replace(/@\{bg\s+(\w+)\}/gi, ''); // Ignore for now

    // Alignment: @{jleft}, @{jright}, @{jcenter}
    line = line.replace(/@\{j(left|right|center)\}/gi, '');

    return line;
  }

  /**
   * Wrap a line to fit width
   */
  private wrapLine(line: string, width: number): string[] {
    // Don't wrap if line is short enough
    const plainText = line.replace(/\x1b\[[0-9;]*m/g, ''); // Strip ANSI
    if (plainText.length <= width) {
      return [line];
    }

    // Simple word wrapping (preserving ANSI codes)
    const words = line.split(' ');
    const wrapped: string[] = [];
    let current = '';

    for (const word of words) {
      const plainWord = word.replace(/\x1b\[[0-9;]*m/g, '');
      const plainCurrent = current.replace(/\x1b\[[0-9;]*m/g, '');

      if (plainCurrent.length + plainWord.length + 1 > width) {
        if (current) wrapped.push(current);
        current = word;
      } else {
        current += (current ? ' ' : '') + word;
      }
    }

    if (current) wrapped.push(current);
    return wrapped.length ? wrapped : [line];
  }

  /**
   * Get navigation info for a node
   */
  public getNavigationInfo(nodeName: string): {
    prev?: string;
    next?: string;
    toc?: string;
    index?: string;
    help?: string;
  } {
    const node = this.document.nodes.get(nodeName);
    if (!node) return {};

    return {
      prev: node.prev,
      next: node.next,
      toc: node.toc,
      index: node.index,
      help: node.help
    };
  }

  /**
   * Get link by index
   */
  public getLinkByIndex(nodeName: string, index: number): AmigaGuideLink | undefined {
    const node = this.document.nodes.get(nodeName);
    if (!node) return undefined;

    return node.links.find(link => link.index === index);
  }

  /**
   * Get document info
   */
  public getDocument(): AmigaGuideDocument {
    return this.document;
  }

  /**
   * Get node by name
   */
  public getNode(nodeName: string): AmigaGuideNode | undefined {
    return this.document.nodes.get(nodeName);
  }

  /**
   * Get all node names
   */
  public getNodeNames(): string[] {
    return Array.from(this.document.nodes.keys());
  }
}
