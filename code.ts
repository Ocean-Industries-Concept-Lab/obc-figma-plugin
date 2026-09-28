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

// Collections exported as one CSS class per mode (like Component-size). A Palette
// token that aliases into one of them keeps the reference, so the class decides.
const CLASS_EXPORTED_COLLECTIONS = new Set(["Color-categorical"]);

// A collection whose mode could not be picked by name used to make
// followVariableReferences return null, and generateCssPalette then dropped the
// token without a trace: the export still looked plausible while a whole theme
// had lost every primitive-backed colour. The names below drift (Figma renames a
// contrast mode, or a new theme appears), so a miss now falls back to the
// collection's default mode and is reported next to the generated CSS.
const modeFallbacks = new Map<string, string>();
const unresolvedTokens = new Map<string, number>();

function resolveFallbackMode(collection: VariableCollection): { modeId: string; name: string } | undefined {
  const fallback = collection.modes.find((m) => m.modeId === collection.defaultModeId) ?? collection.modes[0];
  if (!fallback) {
    return undefined;
  }
  if (!modeFallbacks.has(collection.name)) {
    const asked = VariableModes[collection.name];
    modeFallbacks.set(
      collection.name,
      asked
        ? 'asked for mode "' + asked + '", which this collection does not have; used "' + fallback.name + '"'
        : 'no mode configured for this collection; used "' + fallback.name + '"'
    );
  }
  return fallback;
}

function generatorWarnings(): string {
  let out = "";
  for (const [name, note] of modeFallbacks) {
    out += "Mode fallback in " + name + ": " + note + "\n";
  }
  for (const [theme, count] of unresolvedTokens) {
    out += "Unresolved: " + count + " token(s) dropped from the " + theme + " block\n";
  }
  if (out) {
    out =
      "The export is not a faithful copy of the file. Check these before pasting it:\n\n" +
      out +
      "\nA mode fallback means VariableModes in code.ts is out of date. Confirm the mode\n" +
      "with the designers and fix the map; the values above were exported with the\n" +
      "collection's default mode.\n";
  }
  return out;
}

// Palette tokens that alias into a class-exported collection, by CSS name and
// theme. They are emitted inside the class blocks, where the mode is known: a
// var() is substituted on the element that declares it, so a reference on the
// theme block would resolve with the default mode for the whole tree.
const classExportedAliases = new Map<string, Map<string, Variable>>();

// Primitive collections: a Palette token that resolves into one keeps a var()
// reference to the primitive, and the primitive is emitted in the same theme
// block, so a consumer overrides one ramp per theme instead of every token.
const PRIMITIVE_COLLECTION_PREFIX = "Color-primitives-";

type PrimitiveRef = {
  kind: "primitive";
  variable: Variable;
  collection: VariableCollection;
  literal: VariableValue;
};

function isPrimitiveRef(value: unknown): value is PrimitiveRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as PrimitiveRef).kind === "primitive"
  );
}

// "Day/Neutral/700" in the day block -> --primitive-neutral-700: the block's
// own theme is already its selector. A block also reaches into another
// theme's primitives (night uses Dusk/Blue/200), and those keep the theme so
// the two 200s do not collide. The prefix keeps the names clear of the
// Palette's own --base-* ramps.
function primitiveCssName(variable: Variable, collection: VariableCollection, blockTheme: string): string {
  const theme = collection.name.slice(PRIMITIVE_COLLECTION_PREFIX.length).toLowerCase();
  const parts = variable.name.split("/");
  if (parts.length > 1 && parts[0].toLowerCase() === theme && theme === blockTheme) {
    parts.shift();
  }
  return "--primitive-" + rename(parts.join("/")).slice(2);
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
    .replace(/styles-/g, "")
    .replace(/integration-beta/g, "integration");
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
  } else if (event.language === "font-exports") {
    return await generateFontExports();
  }
  else if (event.language === "css") {
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
  value: VariableValue | null | undefined, allVariables: Variable[], allCollections: (VariableCollection | null)[], paletteCollection: VariableCollection, mode: { modeId: string; name: string }, variableModes: Record<string, string>, keepPrimitives = false
) : Promise<VariableValue | PrimitiveRef | null | undefined>  {
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
          return followVariableReferences(aliasVariable.valuesByMode[mode.modeId], allVariables, allCollections, paletteCollection, mode, variableModes, keepPrimitives);
        }
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
        } else if (CLASS_EXPORTED_COLLECTIONS.has(collection.name)) {
          return value;
        } else if (collection.id in variableModes) {
          const modeId = variableModes[collection.id];
          collectionMode = collection.modes.find(m => m.modeId === modeId);
        } else if (collection.name in VariableModes) {
          collectionMode = collection.modes.find(m => m.name === VariableModes[collection.name]);
        }

        if (!collectionMode) {
          collectionMode = resolveFallbackMode(collection);
        }
        if (!collectionMode) {
          console.warn("Mode not found", collection.name, collection.modes);
          return null
        }
        const modeValue = aliasVariable.valuesByMode[collectionMode.modeId];
        if (modeValue === null || modeValue === undefined) {
          console.warn("Value is null or undefined", aliasVariable.name, collectionMode.name);
          return null;
        }
        if (keepPrimitives && collection.name.startsWith(PRIMITIVE_COLLECTION_PREFIX)) {
          const literal = await followVariableReferences(modeValue, allVariables, allCollections, paletteCollection, mode, variableModes, false);
          if (literal === null || literal === undefined || isPrimitiveRef(literal)) {
            console.warn("Primitive did not resolve", aliasVariable.name, collectionMode.name);
            return null;
          }
          return { kind: "primitive", variable: aliasVariable, collection, literal };
        }
        const out = await followVariableReferences(modeValue, allVariables, allCollections, paletteCollection, mode, variableModes, keepPrimitives);
        if (out === null || out === undefined) {
          console.warn("Follow variable references returned null", aliasVariable.name, mode.name);
          return null;
        }
        return out;
      }
      return value;
    }

async function generateCssPalette(event: CodegenEvent): Promise<string> {
  // Deliberately not event.node.resolvedVariableModes. Reading the selection's
  // modes made the same file export different CSS depending on what happened to
  // be selected, and it hid the stale names in VariableModes for as long as the
  // selection pinned those collections. The modes now come from VariableModes,
  // then from the collection's default, so an export is reproducible.
  const variableModes: Record<string, string> = {};
  void event;
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
  
  const parsedNames = new Set<string>();
  for (const mode of modes) {
    const cleanName = mode.name.toLowerCase().split(" ")[0];
    if (parsedNames.has(cleanName)) {
      continue;
    }
    parsedNames.add(cleanName);
    if (cleanName === "day") {
      out += ":root, ";
    }
    out += ":root[data-obc-theme='" + cleanName + "'] {\n";
    const fixed = Object.keys(fixedPalletContent).find(c => mode.name.toLowerCase().startsWith(c));
    if (fixed) {
      out += fixedPalletContent[fixed];
    }
    const primitives = new Map<string, string>();
    let declarations = "";
    for (const variable of palletteVariables) {
      const name = rename(variable.name);
      const value = await followVariableReferences(variable.valuesByMode[mode.modeId], allVariables, allCollections, paletteCollection, mode, variableModes, true);

      if (value === null) {
        console.warn("Variable not found", variable.name, mode.name);
        unresolvedTokens.set(cleanName, (unresolvedTokens.get(cleanName) ?? 0) + 1);
        continue;
      } else if (value === undefined) {
        continue;
      }

      if (isPrimitiveRef(value)) {
        const primitive = primitiveCssName(value.variable, value.collection, cleanName);
        const literal = value.literal instanceof Object ? rgbaToHexOrColorName(value.literal as Color) : String(value.literal);
        const known = primitives.get(primitive);
        if (known !== undefined && known !== literal) {
          console.warn("Primitive name collision, emitting the literal", primitive, variable.name, mode.name);
          declarations += "  " + name + ": " + literal + ";\n";
          continue;
        }
        primitives.set(primitive, literal);
        declarations += "  " + name + ": var(" + primitive + ");\n";
        continue;
      }

      if (isVariableAlias(value)) {
        const target = allVariables.find((v) => v.id === value.id) ?? await figma.variables.getVariableByIdAsync(value.id);
        if (target) {
          let byTheme = classExportedAliases.get(name);
          if (!byTheme) {
            byTheme = new Map();
            classExportedAliases.set(name, byTheme);
          }
          byTheme.set(cleanName, target);
        }
        continue;
      }

      if (!(value instanceof Object)) {
        declarations += await value2str(value, name, allVariables);
        continue;
      }
      try {
        const color = rgbaToHexOrColorName(value as Color);
        declarations += "  " + name + ": " + color + ";\n";
      } catch (e) {
        console.warn("Error converting color", variable.name, mode.name, value);
        continue;
      }
    }
    for (const [primitive, literal] of primitives) {
      out += "  " + primitive + ": " + literal + ";\n";
    }
    out += declarations;
    out += "}\n";
  }
  return out;
}

async function generateCssSizes(options: {collectionName: string, cssPrefix: string, rootMode: string}): Promise<string> {
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
    if (mode.name.toLowerCase() === options.rootMode) {
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

// One block per mode of a class-exported collection: the collection's own
// variables, then the Palette tokens that alias into it. A token whose target
// differs by theme gets a theme-scoped block per differing theme, so the
// automation ramp reversal in dusk and night lands on the class element too.
async function generateClassExportedBlocks(options: {collectionName: string, cssPrefix: string, rootMode: string, defaultTheme: string}): Promise<string> {
  const allVariables = await figma.variables.getLocalVariablesAsync();
  const collectionIds = allVariables.map((v) => v.variableCollectionId);
  const uniqueCollections = await Promise.all(
    Array.from(new Set(collectionIds)).map((i) =>
      figma.variables.getVariableCollectionByIdAsync(i)
    )
  );
  const collection = uniqueCollections.find((c) => c?.name === options.collectionName);
  if (!collection) {
    return "";
  }
  const ownVariables = allVariables.filter((v) => v.variableCollectionId === collection.id);
  let out = "";
  for (const mode of collection.modes) {
    const modeName = mode.name.toLowerCase();
    const classSelector = options.cssPrefix + modeName;
    out += (modeName === options.rootMode ? ":root, " : "") + classSelector + " {\n";
    for (const variable of ownVariables) {
      out += await value2str(variable.valuesByMode[mode.modeId], rename(variable.name), allVariables);
    }
    const scoped = new Map<string, string>();
    for (const [name, byTheme] of classExportedAliases) {
      const defaultTarget = byTheme.get(options.defaultTheme) ?? byTheme.values().next().value;
      if (!defaultTarget || defaultTarget.variableCollectionId !== collection.id) {
        continue;
      }
      out += "  " + name + ": var(" + rename(defaultTarget.name) + ");\n";
      for (const [theme, target] of byTheme) {
        if (theme === options.defaultTheme || target.id === defaultTarget.id) {
          continue;
        }
        scoped.set(theme, (scoped.get(theme) ?? "") + "  " + name + ": var(" + rename(target.name) + ");\n");
      }
    }
    out += "}\n";
    for (const [theme, declarations] of scoped) {
      const themed = ":root[data-obc-theme='" + theme + "']";
      const selectors = [themed + " " + classSelector, themed + classSelector];
      if (modeName === options.rootMode) {
        selectors.unshift(themed);
      }
      out += selectors.join(", ") + " {\n" + declarations + "}\n";
    }
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

function isVariableAlias(
  value: VariableValue | null | undefined
): value is VariableAlias {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as VariableAlias).type === "VARIABLE_ALIAS"
  );
}

// Fix for https://github.com/Ocean-Industries-Concept-Lab/obc-figma-plugin/issues/1
//
// The size loops (generateCssSizes / generateCssSizesFixedMode) emit alias
// references via value2str as `var(--<target>)` unconditionally. When the alias
// target lives in a collection that is NOT part of the css-variables export
// (e.g. Set-instrument-digits, Set-scale-type), that `var(--<target>)` has no
// matching `--<target>:` definition anywhere in the output, producing a dangling
// reference that silently resolves to `unset` at runtime.
//
// This resolver walks every alias used by the exported size collections,
// collects the targets that live in non-exported (intermediate) collections, and
// emits a top-level definition for each using that collection's default mode.
// The indirection is preserved, so the intermediate "switch" collections can
// still be overridden at runtime, while the emitted CSS becomes self-contained.
async function generateDanglingAliasTargets(
  exportedCollectionNames: string[]
): Promise<string> {
  const allVariables = await figma.variables.getLocalVariablesAsync();
  const variableById = new Map<string, Variable>();
  for (const v of allVariables) {
    variableById.set(v.id, v);
  }

  const collectionIds = Array.from(
    new Set(allVariables.map((v) => v.variableCollectionId))
  );
  const collections = await Promise.all(
    collectionIds.map((id) =>
      figma.variables.getVariableCollectionByIdAsync(id)
    )
  );
  const collectionById = new Map<string, VariableCollection>();
  for (const c of collections) {
    if (c) {
      collectionById.set(c.id, c);
    }
  }

  const exportedCollectionIds = new Set<string>();
  for (const name of exportedCollectionNames) {
    const collection = collections.find((c) => c?.name === name);
    if (collection) {
      exportedCollectionIds.add(collection.id);
    }
  }

  const getVariable = async (id: string): Promise<Variable | null> => {
    const cached = variableById.get(id);
    if (cached) {
      return cached;
    }
    const fetched = await figma.variables.getVariableByIdAsync(id);
    if (fetched) {
      variableById.set(fetched.id, fetched);
    }
    return fetched;
  };

  // Breadth-first collection of intermediate alias targets, with transitive
  // closure and cycle protection (these chains can bounce between collections,
  // e.g. Component-size -> Set-instrument-digits -> Component-size).
  const queued = new Set<string>();
  const queue: string[] = [];
  const enqueueTarget = async (value: VariableValue | null | undefined) => {
    if (!isVariableAlias(value)) {
      return;
    }
    const target = await getVariable(value.id);
    if (
      target &&
      !exportedCollectionIds.has(target.variableCollectionId) &&
      !queued.has(target.id)
    ) {
      queued.add(target.id);
      queue.push(target.id);
    }
  };

  for (const variable of allVariables) {
    if (!exportedCollectionIds.has(variable.variableCollectionId)) {
      continue;
    }
    for (const modeValue of Object.values(variable.valuesByMode)) {
      await enqueueTarget(modeValue);
    }
  }

  let out = "";
  const emittedNames = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const variable = await getVariable(id);
    if (!variable) {
      continue;
    }
    const collection = collectionById.get(variable.variableCollectionId);
    if (!collection) {
      continue;
    }
    // Use the collection's default mode to represent the design-time default,
    // matching the mode the designers selected as the baseline.
    const mode =
      collection.modes.find((m) => m.modeId === collection.defaultModeId) ??
      collection.modes[0];
    const value = variable.valuesByMode[mode.modeId];
    if (value === null || value === undefined) {
      continue;
    }
    // The intermediate value may itself alias another non-exported collection.
    await enqueueTarget(value);
    const name = rename(variable.name);
    if (emittedNames.has(name)) {
      continue;
    }
    emittedNames.add(name);
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
  classExportedAliases.clear();
  modeFallbacks.clear();
  unresolvedTokens.clear();
  let out = await generateCssSizes({collectionName: "Component-size", cssPrefix: ".obc-component-size-", rootMode: "regular"});
  out += "* {\n";
  out += await generateCssSizesFixedMode({collectionName: ".typography-primitives", mode: "Regular"});
  out += await generateCssSizesFixedMode({collectionName: "Typography-primitives-6.2", mode: "Value"});
  out += await generateCssSizesFixedMode({collectionName: "Set-component-corners", mode: "Regular"});
  out += await generateCssSizesFixedMode({collectionName: "component-primitives", mode: "Value"});
  out += await generateDanglingAliasTargets([
    "Component-size",
    ".typography-primitives",
    "Set-component-corners",
    "component-primitives",
  ]);
  out += fixedCssContent;
  out += "} \n";
  out += "\n\n" + await generateCssPalette(event);
  out += "\n" + await generateClassExportedBlocks({collectionName: "Color-categorical", cssPrefix: ".obc-categorical-color-", rootMode: "neutral", defaultTheme: "day"});
  out += extraCss;

  const results: CodegenResult[] = [
    {
      language: "CSS",
      code: out,
      title: "Codegen Plugin",
    },
  ];
  const warnings = generatorWarnings();
  if (warnings) {
    results.unshift({
      language: "PLAINTEXT",
      code: warnings,
      title: "⚠ Export warnings",
    });
  }
  return results;
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

async function generateFontExports(): Promise<CodegenResult[]> {
  const textStyles = await figma.getLocalTextStylesAsync();
  let out = "";

  for (const textStyle of textStyles) {
    const name = renameFont(textStyle.name);
    out += `@define-mixin font-${name} {\n`;
    if (textStyle.boundVariables?.fontFamily) {
       out += await value2str(textStyle.boundVariables.fontFamily, "font-family", []);
    } else {
      out += "font-family: " + textStyle.fontName.family + ";\n";
    }
    if (textStyle.boundVariables?.fontWeight) {
      out += await value2str(textStyle.boundVariables.fontWeight, "font-weight", []);
    }
    if (textStyle.boundVariables?.fontSize) {
      out += await value2str(textStyle.boundVariables.fontSize, "font-size", []);
    }
    if (textStyle.boundVariables?.lineHeight) {
      out += await value2str(textStyle.boundVariables.lineHeight, "line-height", []);
    }
    if (textStyle.boundVariables?.letterSpacing) {
      out += await value2str(textStyle.boundVariables.letterSpacing, "letter-spacing", []);
    }
    out += "  font-feature-settings: 'liga' off, 'clig' off, 'ss04' on;\n";
    out += "}\n\n";
  }
  return [
    {
      language: "CSS",
      code: out,
      title: "Codegen Plugin",
    },
  ];
}

function renameFont(name: string): string {
  return name.toLowerCase()
      .replace(/ /g, "-")
      .replace(/\//g, "-")
      .replace(/ui-/, "");
}
