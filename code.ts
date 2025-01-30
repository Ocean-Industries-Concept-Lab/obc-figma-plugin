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
  return "--" + parts.join('-');
}


figma.codegen.on('generate', async (event) => {
  if (event.language === 'variables' && false) {
    return await generateColorVariableMap(event);
  } else {
    return await generateCssPaletteFromVariabler(event);
  }
});

async function generateColorVariableMap(event: CodegenEvent): Promise<CodegenResult[]> {
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
  )))).filter(variable => variable.colorName !== undefined) as { id: string; colorName: string; }[];
  const variableMap: Record<string, string> = {};
  variables.forEach(variable => variableMap[variable.id] = rename(variable.colorName));;
  const code = JSON.stringify(variableMap,
    null, 2);
  return [
    {
      language: 'JSON',
      code: code,
      title: 'Codegen Plugin',
    },
  ];
}

async function generateCssPaletteFromVariabler(event: CodegenEvent): Promise<CodegenResult[]> {
  console.log("generateCssPaletteFromVariabler1"); 
  const allVariables = await figma.variables.getLocalVariablesAsync("COLOR");
  const collectionIds = allVariables.map(v => v.variableCollectionId);
  const allCollections = await Promise.all(collectionIds.map(i => figma.variables.getVariableCollectionByIdAsync(i)));
  const uniqueCollections = await Promise.all(Array.from(new Set(collectionIds)).map(i => figma.variables.getVariableCollectionByIdAsync(i)));
  const paletteCollection = uniqueCollections.find(c => c?.name === "Palette");
  if (!paletteCollection) {
    return [{
      language: 'CSS',
      code: "Pallette collection not found",
      title: 'Codegen Plugin',
    },];
  }

  const modes = paletteCollection.modes;
  const palletteVariables = allVariables.filter(v => v.variableCollectionId === paletteCollection.id);
  let out = ""
  for (const mode of modes) {
    out += ":root[data-obc-theme='" + mode.name.toLowerCase() + "'] {\n";
    for (const variable of palletteVariables) {
      let value = variable.valuesByMode[mode.modeId];
      if (!(value instanceof Object)) {
        console.warn("skipping", value);
        continue;
      }
      if ("type" in value && value.type === "VARIABLE_ALIAS") {
        const alias = value as VariableAlias;
        let aliasVariable: Variable | null | undefined = allVariables.find(v => v.id === alias.id);
        if (!aliasVariable) {
          aliasVariable = await figma.variables.getVariableByIdAsync(alias.id);
          if (!aliasVariable) {
            console.warn("Variable not found", alias.id);
            continue;
          }
        }
        if (aliasVariable.variableCollectionId === paletteCollection.id) {
          value = aliasVariable.valuesByMode[mode.modeId];
        } else {
          const collection = allCollections.find(c => c?.id === aliasVariable.variableCollectionId);
          if (!collection) {
            console.warn("Collection not found", aliasVariable.variableCollectionId);
            continue;
          }
          const collectionMode = collection.modes.length === 1 ?
            collection.modes[0]
            : collection.modes.find(m => m.name === "WCAG" || m.name === "Default");
          if (!collectionMode) {
            console.warn("Mode not found", "WCAG", collection.modes);
            continue;
          }
          value = aliasVariable.valuesByMode[collectionMode.modeId];
        }
        
      }
      const color = rgbaToHexOrColorName(value as Color);
        const name = rename(variable.name);
        out += "  " + name + ": " + color + ";\n";
    }
    out += "}\n";
  }

return [{
  language: 'CSS',
  code: out,
  title: 'Codegen Plugin',
},];
}

function decimalToHex(d: number): string {
  const v = Math.round(d * 255).toString(16);
  return v.length === 1 ? `0${v}` : v;
}

type Color = {
  /** Red channel value, between 0 and 1 */
  r: number;
  /** Green channel value, between 0 and 1 */
  g: number;
  /** Blue channel value, between 0 and 1 */
  b: number;
  /** Alpha channel value, between 0 and 1 */
  a: number;
};

function rgbaToHexOrColorName(rgba: Color): string {
  if (rgba.a < 1) {
    return `rgb(${Math.round(rgba.r * 255)}, ${Math.round(rgba.g * 255)}, ${Math.round(rgba.b * 255)}, ${rgba.a})`;
  } else {
    return `rgb(${Math.round(rgba.r * 255)}, ${Math.round(rgba.g * 255)}, ${Math.round(rgba.b * 255)})`;
  }
}