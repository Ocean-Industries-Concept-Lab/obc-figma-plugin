// This plugin will generate a sample codegen plugin
// that appears in the Element tab of the Inspect panel.

// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.
// You can access browser APIs in the <script> tag inside "ui.html" which has a
// full browser environment (See https://www.figma.com/plugin-docs/how-plugins-run).

// This provides the callback to generate the code.
function rename(name: string): string {
  const o = name.toLowerCase().replace(/\//g, '-').replace(/styles-/g, '');
  const parts = o.split('-');
  if (parts.length > 1 && parts[1] === 'on') {
    parts.shift();
  }
  return parts.join('-');
}


figma.codegen.on('generate', async (event) => {
  const colorIds: string[] = [];

  const findColorIds = (node: SceneNode) => {
    if ('children' in node) {
      for (const child of node.children) {
        findColorIds(child);
        }
      }
    
    if ('fills' in node) {
      const fills = node.fills;
      if (Array.isArray(fills)) {
      for (const fill of fills) {
        if (fill.type === 'SOLID' && fill.boundVariables?.color) {
        colorIds.push(fill.boundVariables.color.id);
        }
      }
      }
    }

    if ('strokes' in node) {
      const strokes = node.strokes;
      if (Array.isArray(strokes)) {
      for (const stroke of strokes) {
        if (stroke.type === 'SOLID' && stroke.boundVariables?.color) {
        colorIds.push(stroke.boundVariables.color.id);
        }
      }
      }
    }
  };
  findColorIds(event.node);
  const uniqueColorIds = Array.from(new Set(colorIds));
  const variables = (await Promise.all(uniqueColorIds.map(async (id) => ({
    id,
    colorName: (await figma.variables.getVariableByIdAsync(id))?.name
  }
  )))).filter(variable => variable.colorName !== undefined) as {id: string, colorName: string}[];
  const variableMap: Record<string, string> = {};
  variables.forEach(variable => variableMap[variable.id]= rename(variable.colorName)); ;
  const code = JSON.stringify(variableMap
  , null, 2);
  console.log(code,variableMap);
  return [
    {
      language: 'JSON',
      code: code,
      title: 'Codegen Plugin',
    },
  ];
});
