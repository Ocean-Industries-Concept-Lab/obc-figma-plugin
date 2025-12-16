// This plugin will generate a sample codegen plugin
// that appears in the Element tab of the Inspect panel.

// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.
// You can access browser APIs in the <script> tag inside "ui.html" which has a
// full browser environment (See https://www.figma.com/plugin-docs/how-plugins-run).


const VariableModes: Record<string, string> = {
  "Palette-night-config": "Default",
  "Palette-dusk-configuration": "v2",
  "Palette-day-configuration": "Regular",
  "Color-primitives-dusk": "WCAG 6.1",
  "Color-primitives-day": "WCAG",
  "Color-primitives-night": "WCAG",
  "dusk-configuration": "v2",
}

// This provides the callback to generate the code.
function rename(name: string): string {
  let o = name
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/ /g, "-")
    .replace(/&/g, "")
    .replace(/\(/g, "")
    .replace(/\)/g, "")
    .replace(/--/g, "-")
    .replace(/styles-/g, "");
  const hasOnRegex = /^.*-on-(.*)$/;
  const hasIntegrationRegex = /^.*-integration-(.*)$/;
  if (hasOnRegex.test(o) && !hasIntegrationRegex.test(o)) {
    const match = hasOnRegex.exec(o);
    if (match) {
      o = "on-" + match[1];
    }
  }

  const parts = o.split("-");
  

  if (parts.length > 1 && parts[0] === "color") {
    parts.shift();
  }
  return "--" + parts.join("-");
}

figma.codegen.on("generate", async (event) => {
  if (event.language === "variables") {
    return await generateColorVariableMap(event);
  } else if (event.language === "cssvariables") {
    return await generateCssPaletteFromVariabler(event);
  } else if (event.language === "css") {
    return await getCss(event);
  } else {
    throw new Error("Unsupported language: " + event.language);
  }
});

const cssCustomPropertyRegEx = /var\(([^)(]*?),([^)(]*?)(\(.*?\))?\)/g;

async function getCss(event: CodegenEvent): Promise<CodegenResult[]> {
   const css = await event.node.getCSSAsync();
  const result = [];
  for (const key in css) {
    let value = css[key];
    // Replace css custom properties with lower case version and remove default values
    value = value.replace(cssCustomPropertyRegEx, (match, p1) => {
      // Remove default value
      // remove -- from p1 before renaming
      p1 = p1.replace(/--/g, "");
      return "var(" + rename(p1) + ")";
    });

    result.push(key + ": " + value + ";");
  }

  return [
    {
      language: "CSS",
      code: result.join("\n"),
      title: "Codegen Plugin",
    },
  ];
}

async function generateColorVariableMap(
  event: CodegenEvent
): Promise<CodegenResult[]> {
  const colorIds: string[] = [];

  const findColorIds = (node: SceneNode) => {
    if ("children" in node) {
      for (const child of node.children) {
        findColorIds(child);
      }
    }

    if ("fills" in node) {
      const fills = node.fills;
      if (Array.isArray(fills)) {
        for (const fill of fills) {
          if (fill.type === "SOLID" && fill.boundVariables?.color) {
            colorIds.push(fill.boundVariables.color.id);
          }
        }
      }
    }

    if ("strokes" in node) {
      const strokes = node.strokes;
      if (Array.isArray(strokes)) {
        for (const stroke of strokes) {
          if (stroke.type === "SOLID" && stroke.boundVariables?.color) {
            colorIds.push(stroke.boundVariables.color.id);
          }
        }
      }
    }
  };
  findColorIds(event.node);
  const uniqueColorIds = Array.from(new Set(colorIds));
  const variables = (
    await Promise.all(
      uniqueColorIds.map(async (id) => ({
        id,
        colorName: (await figma.variables.getVariableByIdAsync(id))?.name,
      }))
    )
  ).filter((variable) => variable.colorName !== undefined) as {
    id: string;
    colorName: string;
  }[];
  const variableMap: Record<string, string> = {};
  variables.forEach(
    (variable) => (variableMap[variable.id] = rename(variable.colorName).replace("--", ""))
  );
  const code = JSON.stringify(variableMap, null, 2);
  return [
    {
      language: "JSON",
      code: code,
      title: "Codegen Plugin",
    },
  ];
}

async function followVariableReferences(
  value: VariableValue | null | undefined, allVariables: Variable[], allCollections: (VariableCollection | null)[], paletteCollection: VariableCollection, mode: { modeId: string; name: string }, variableModes: Record<string, string>
) : Promise<VariableValue | null | undefined>  {
    if (value === null || value === undefined) {
      console.warn("Value is null or undefined", value);
      return null;
    }
    if (typeof value === "object" && "type" in value && value.type === "VARIABLE_ALIAS") {
        const alias = value as VariableAlias;
        let aliasVariable: Variable | null | undefined = allVariables.find(
          (v) => v.id === alias.id
        );
        if (!aliasVariable) {
          aliasVariable = await figma.variables.getVariableByIdAsync(alias.id);
          if (!aliasVariable) {
            console.warn("Variable not found", alias.id);
            return null
          }
        }
        if (aliasVariable.variableCollectionId === paletteCollection.id) {
          value = aliasVariable.valuesByMode[mode.modeId];
          value = await followVariableReferences(value, allVariables, allCollections, paletteCollection, mode, variableModes);
        } else {
          let collection = allCollections.find(
            (c) => c?.id === aliasVariable.variableCollectionId
          );
          if (!collection) {
             collection = await figma.variables.getVariableCollectionByIdAsync(aliasVariable.variableCollectionId);
             if (!collection) {
               console.info(
                 "Collection not found",
                 aliasVariable.variableCollectionId
               );
               return null
             }
             console.log("Collection found", collection.name, collection.modes);
            allCollections.push(collection);
          }
          let collectionMode: { modeId: string; name: string } | undefined;
          if (collection.modes.length === 1) {
            collectionMode = collection.modes[0];
          } else if (collection.name === "Color-categorical") {
            return undefined;
          }  else if (collection.id in variableModes) {
            const modeId = variableModes[collection.id];
            collectionMode = collection.modes.find(m => m.modeId === modeId);
          } else if (collection.name in VariableModes) {
            collectionMode = collection.modes.find(m => m.name === VariableModes[collection.name]);
          } else {
            console.warn("Collection mode not found", collection.name, collection.modes);
            return null
          }
          
          if (!collectionMode) {
            console.warn("Mode not found", collection.name, collection.modes);
            return null
          }
          value = aliasVariable.valuesByMode[collectionMode.modeId];
          if (value === null || value === undefined) {
            console.warn("Value is null or undefined", aliasVariable.name, collectionMode.name);
            return null;
          }
          const out = await followVariableReferences(value, allVariables, allCollections, paletteCollection, mode, variableModes);
          if (out === null || out === undefined) {
            console.warn("Follow variable references returned null", aliasVariable.name, mode.name);
            return null;
          }
          value = out;
        }
      }
      return value;
    }

async function generateCssPalette(event: CodegenEvent): Promise<string> {
  const variableModes = event.node.resolvedVariableModes;
  console.log("generateCssPaletteFromVariabler1");
  const allVariables = await figma.variables.getLocalVariablesAsync();
  const collectionIds = allVariables.map((v) => v.variableCollectionId);
  const allCollections = await Promise.all(
    collectionIds.map((i) => figma.variables.getVariableCollectionByIdAsync(i))
  );
  const uniqueCollections = await Promise.all(
    Array.from(new Set(collectionIds)).map((i) =>
      figma.variables.getVariableCollectionByIdAsync(i)
    )
  );
  const paletteCollection = uniqueCollections.find(
    (c) => c?.name === "Palette"
  );
  if (!paletteCollection) {
    return "Pallette collection not found";
  }

  const modes = paletteCollection.modes;
  const palletteVariables = allVariables.filter(
    (v) => v.variableCollectionId === paletteCollection.id
  );
  let out = "";
  for (const mode of modes) {
    if (mode.name.toLowerCase() === "day") {
      out += ":root, ";
    }
    out += ":root[data-obc-theme='" + mode.name.toLowerCase() + "'] {\n";
    out += fixedPalletContent[mode.name.toLowerCase()];
    for (const variable of palletteVariables) {
      let value: VariableValue | null | undefined = variable.valuesByMode[mode.modeId];
      const name = rename(variable.name);
      value = await followVariableReferences(value, allVariables, allCollections, paletteCollection, mode, variableModes);
     

      if (value === null) {
        console.warn("Variable not found", variable.name, mode.name);
        continue;
      } else if (value === undefined) {
        continue;
      }

      if (!(value instanceof Object)) {
        out += await value2str(value, name, allVariables);
        continue;
      } 
      try {
        const color = rgbaToHexOrColorName(value as Color);
        out += "  " + name + ": " + color + ";\n";
      } catch (e) {
        console.warn("Error converting color", variable.name, mode.name, value);
        continue;
      }
      
    }
    out += "}\n";
  }
  return out;
}

async function generateCssSizes(options: {collectionName: string, cssPrefix: string}): Promise<string> {
  console.log("generate css sizes");
  const allVariables = await figma.variables.getLocalVariablesAsync();
  const collectionIds = allVariables.map((v) => v.variableCollectionId);
  const uniqueCollections = await Promise.all(
    Array.from(new Set(collectionIds)).map((i) =>
      figma.variables.getVariableCollectionByIdAsync(i)
    )
  );
  const paletteCollection = uniqueCollections.find(
    (c) => c?.name === options.collectionName
  );
  if (!paletteCollection) {
    return "Component size collection not found";
  }

  const modes = paletteCollection.modes;
  const palletteVariables = allVariables.filter(
    (v) => v.variableCollectionId === paletteCollection.id
  );
  let out = "";
  for (const mode of modes) {
    if (mode.name.toLowerCase() === "regular") {
      out += ":root, ";
    }
    out += options.cssPrefix + mode.name.toLowerCase() + " {\n";
    for (const variable of palletteVariables) {
      const name = rename(variable.name);
      const value = variable.valuesByMode[mode.modeId];
      out += await value2str(value, name, allVariables);
    }
    out += "}\n";
  }
  return out;
}

async function generateCssSizesFixedMode(options: {collectionName: string, mode: string}): Promise<string> {
  const allVariables = await figma.variables.getLocalVariablesAsync();
  const collectionIds = allVariables.map((v) => v.variableCollectionId);
  const uniqueCollections = await Promise.all(
    Array.from(new Set(collectionIds)).map((i) =>
      figma.variables.getVariableCollectionByIdAsync(i)
    )
  );
  const paletteCollection = uniqueCollections.find(
    (c) => c?.name === options.collectionName
  );
  if (!paletteCollection) {
    return "Component size collection not found";
  }

  const palletteVariables = allVariables.filter(
    (v) => v.variableCollectionId === paletteCollection.id
  );
  let out = "";
  const mode = paletteCollection.modes.length > 1 ? paletteCollection.modes.find(m => m.name === options.mode)! : paletteCollection.modes[0];
  for (const variable of palletteVariables) {
    const name = rename(variable.name);
    const value = variable.valuesByMode[mode.modeId];
    out += await value2str(value, name, allVariables);
  }
  
  return out;
}

async function value2str(value: VariableValue | null | undefined, name: string, allVariables: Variable[]): Promise<string> {
  if (value === null) {
    console.warn("Value is null or undefined", name);
    return "";
  }
  if (value === undefined) {
    throw new Error("Value is undefined: " + name);
  }
  if (typeof value === "number") {
    if (name.includes("font-weight")) {
      return "  " + name + ": " + value + ";\n";
    }
    return "  " + name + ": " + value + "px;\n";
  } else if (typeof value === "string") {
    if (value === "noto-sans") {
      value = "Noto Sans";
    } else if (value === "open-sans") {
      value = "Open Sans";
    }
    return `  ${name}: '${value}';\n`;
  } else if (typeof value === "object"  && "type" in value && value.type === "VARIABLE_ALIAS") {
    const alias = value as VariableAlias;
    let aliasVariable: Variable | null | undefined = allVariables.find(
      (v) => v.id === alias.id
    );
    if (!aliasVariable) {
      aliasVariable = await figma.variables.getVariableByIdAsync(alias.id);
      if (!aliasVariable) {
        console.warn("Variable not found", alias.id);
        return "";
      }
    }
    return "  " + name + ": var(" + rename(aliasVariable.name) + ");\n";
  } else {
    console.warn("skipping", value);
    return "";
  }
}

async function generateCssPaletteFromVariabler( event: CodegenEvent): Promise<CodegenResult[]> {
  let out = await generateCssSizes({collectionName: "Component-size", cssPrefix: ".obc-component-size-"});
  out += "* {\n";
  out += await generateCssSizesFixedMode({collectionName: ".typography-primitives", mode: "Regular"});
  out += await generateCssSizesFixedMode({collectionName: "Set-component-corners", mode: "Regular"});
  out += await generateCssSizesFixedMode({collectionName: "component-primitives", mode: "Value"});
  out += fixedCssContent;
  out += "} \n";
  out += "\n\n" + await generateCssPalette(event);
  out += extraCss;

  return [
    {
      language: "CSS",
      code: out,
      title: "Codegen Plugin",
    },
  ];
}

const fixedCssContent= ` --shadow-flat: var(--shadow-flat-x) var(--shadow-flat-y)
    var(--shadow-flat-blur) var(--shadow-flat-spread) var(--shadow-flat-color);
  --shadow-raised: var(--shadow-raised-x) var(--shadow-raised-y)
    var(--shadow-raised-blur) var(--shadow-raised-spread)
    var(--shadow-raised-color);
  --shadow-floating: var(--shadow-floating-x) var(--shadow-floating-y)
    var(--shadow-floating-blur) var(--shadow-floating-spread)
    var(--shadow-floating-color);
  --shadow-overlay: var(--shadow-overlay-x) var(--shadow-overlay-y)
    var(--shadow-overlay-blur) var(--shadow-overlay-spread)
    var(--shadow-overlay-color);
    `;

const fixedPalletContent: {[pallet: string]: string} = {
  "day": `  --icon-02-chevron-up: url('data:image/svg+xml,<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 14.0002L7.41 15.4102L12 10.8302L16.59 15.4102L18 14.0002L12 8.00016L6 14.0002Z" fill="rgba(0, 0, 0, 0.55)"/></svg>');
  --icon-02-chevron-down: url('data:image/svg+xml,<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M18 9.41L16.59 8L12 12.58L7.41 8L6 9.41L12 15.41L18 9.41Z" fill="rgba(0, 0, 0, 0.55)"/></svg>');`,
  "dusk": `  --icon-02-chevron-up: url('data:image/svg+xml,<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 14.0002L7.41 15.4102L12 10.8302L16.59 15.4102L18 14.0002L12 8.00016L6 14.0002Z" fill="rgba(255, 255, 255, .550)"/></svg>');
  --icon-02-chevron-down: url('data:image/svg+xml,<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M18 9.41L16.59 8L12 12.58L7.41 8L6 9.41L12 15.41L18 9.41Z" fill="rgba(255, 255, 255, .550)"/></svg>');
  `,
  "night": `--icon-02-chevron-up: url('data:image/svg+xml,<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 14.0002L7.41 15.4102L12 10.8302L16.59 15.4102L18 14.0002L12 8.00016L6 14.0002Z" fill="rgb(51, 51, 0)"/></svg>');
  --icon-02-chevron-down: url('data:image/svg+xml,<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M18 9.41L16.59 8L12 12.58L7.41 8L6 9.41L12 15.41L18 9.41Z" fill="rgb(51, 51, 0)"/></svg>');
  `,
  "bright": ` --icon-02-chevron-up: url('data:image/svg+xml,<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 14.0002L7.41 15.4102L12 10.8302L16.59 15.4102L18 14.0002L12 8.00016L6 14.0002Z" fill="rgba(0, 0, 0, .650)"/></svg>');
  --icon-02-chevron-down: url('data:image/svg+xml,<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="    M18 9.41L16.59 8L12 12.58L7.41 8L6 9.41L12 15.41L18 9.41Z" fill="rgba(0, 0, 0, .650)"/></svg>');
  `,
};

const extraCss = `
@property --alarm-blink-on {
  syntax: "<number>";
  inherits: true;
  initial-value: 1;
}

@property --alarm-blink-off {
  syntax: "<number>";
  inherits: true;
  initial-value: 0;
}

@keyframes warning-blink {
  0% {
    --warning-blink-on: 1;
    --warning-blink-off: 0;
    --alarm-blink-on: 1;
    --alarm-blink-off: 0;
  }

  25% {
    --alarm-blink-on: 0;
    --alarm-blink-off: 1;
  }

  50% {
    --warning-blink-on: 0;
    --warning-blink-off: 1;
    --alarm-blink-on: 1;
    --alarm-blink-off: 0;
  }

  75% {
    --alarm-blink-on: 0;
    --alarm-blink-off: 1;
  }

  100% {
    --warning-blink-on: 1;
    --warning-blink-off: 0;
  }
}

@property --warning-blink-on {
  syntax: "<number>";
  inherits: true;
  initial-value: 1;
}

@property --warning-blink-off {
  syntax: "<number>";
  inherits: true;
  initial-value: 0;
}

:root {
  animation: warning-blink 4s infinite;
  animation-timing-function: steps(1);
}

`

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
    return `rgb(${Math.round(rgba.r * 255)}, ${Math.round(
      rgba.g * 255
    )}, ${Math.round(rgba.b * 255)}, ${rgba.a})`;
  } else {
    if (Number.isNaN(Math.round(rgba.r * 255))) {
      throw new Error("NaN: " + JSON.stringify(rgba));
    }
    return `rgb(${Math.round(rgba.r * 255)}, ${Math.round(
      rgba.g * 255
    )}, ${Math.round(rgba.b * 255)})`;
  }
}