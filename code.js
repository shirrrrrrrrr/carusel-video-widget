// Typography Breakpoint Variables — Figma plugin (main thread / sandbox)
// ---------------------------------------------------------------------------
// Creates a Variable Collection for typography with one MODE per breakpoint
// (Desktop / Tablet / Mobile) and one FLOAT/STRING variable per typographic
// property, grouped by token (e.g. "heading/h1/fontSize").
//
// Runs in the Figma plugin sandbox. UI lives in ui.html and talks to this file
// through figma.ui.postMessage / figma.ui.onmessage.
// ---------------------------------------------------------------------------

figma.showUI(__html__, { width: 460, height: 720, themeColors: true });

// ---------------------------------------------------------------------------
// Small compatibility helpers (the Variables API signatures changed over time,
// and some methods only exist as async variants on newer editors).
// ---------------------------------------------------------------------------

async function getLocalCollections() {
  if (figma.variables.getLocalVariableCollectionsAsync) {
    return figma.variables.getLocalVariableCollectionsAsync();
  }
  return figma.variables.getLocalVariableCollections();
}

async function getLocalVariables() {
  if (figma.variables.getLocalVariablesAsync) {
    return figma.variables.getLocalVariablesAsync();
  }
  return figma.variables.getLocalVariables();
}

async function getLocalTextStyles() {
  if (figma.getLocalTextStylesAsync) {
    return figma.getLocalTextStylesAsync();
  }
  return figma.getLocalTextStyles();
}

function createVariable(name, collection, type) {
  // Newer API takes the collection object, older one took its id.
  try {
    return figma.variables.createVariable(name, collection, type);
  } catch (err) {
    return figma.variables.createVariable(name, collection.id, type);
  }
}

function setExplicitMode(node, collection, modeId) {
  try {
    node.setExplicitVariableModeForCollection(collection, modeId);
  } catch (err) {
    node.setExplicitVariableModeForCollection(collection.id, modeId);
  }
}

// ---------------------------------------------------------------------------
// Collection / mode setup
// ---------------------------------------------------------------------------

// Find an existing collection by name, or create a fresh one.
async function getOrCreateCollection(name) {
  const collections = await getLocalCollections();
  const existing = collections.find(function (c) { return c.name === name; });
  if (existing) return existing;
  return figma.variables.createVariableCollection(name);
}

// Ensure the collection has exactly one mode per requested breakpoint and
// return a map { breakpointKey -> modeId }. Renames/adds/reuses as needed.
function ensureModes(collection, modes) {
  const result = {};
  const warnings = [];

  // The collection always ships with a default mode we can repurpose.
  modes.forEach(function (mode, index) {
    const wanted = mode.name;
    const already = collection.modes.find(function (m) { return m.name === wanted; });
    if (already) {
      result[mode.key] = already.modeId;
      return;
    }

    if (index === 0) {
      // Reuse the built-in default mode for the first breakpoint.
      const first = collection.modes[0];
      collection.renameMode(first.modeId, wanted);
      result[mode.key] = first.modeId;
      return;
    }

    try {
      const modeId = collection.addMode(wanted);
      result[mode.key] = modeId;
    } catch (err) {
      warnings.push(wanted);
    }
  });

  return { modeIds: result, warnings: warnings };
}

// ---------------------------------------------------------------------------
// Variable lookup / creation
// ---------------------------------------------------------------------------

function round(value, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// A single description of one variable to create per token property.
// key: property key in the token/breakpoint payload
// suffix: variable name suffix
// type: Figma resolved data type
var PROPERTY_DEFS = [
  { key: 'fontFamily', suffix: 'fontFamily', type: 'STRING', scalable: false },
  { key: 'fontWeight', suffix: 'fontWeight', type: 'FLOAT', scalable: false },
  { key: 'fontSize', suffix: 'fontSize', type: 'FLOAT', scalable: true },
  { key: 'lineHeight', suffix: 'lineHeight', type: 'FLOAT', scalable: true },
  { key: 'letterSpacing', suffix: 'letterSpacing', type: 'FLOAT', scalable: true }
];

async function createTypographyVariables(payload) {
  const collectionName = payload.collectionName || 'Typography';
  const modes = payload.modes; // [{ key, name, width }]
  const tokens = payload.tokens; // [{ name, values: { <mode.key>: { fontFamily,... } } }]
  const enabled = payload.properties || {};
  const decimals = typeof payload.decimals === 'number' ? payload.decimals : 2;

  const collection = await getOrCreateCollection(collectionName);
  const modeResult = ensureModes(collection, modes);
  const modeIds = modeResult.modeIds;

  // Index existing variables in this collection so we update instead of dupe.
  const allVars = await getLocalVariables();
  const existingByName = {};
  allVars.forEach(function (v) {
    if (v.variableCollectionId === collection.id) existingByName[v.name] = v;
  });

  const activeProps = PROPERTY_DEFS.filter(function (p) { return enabled[p.key] !== false; });

  let created = 0;
  let updated = 0;

  for (var t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (!token.name) continue;

    for (var p = 0; p < activeProps.length; p++) {
      const prop = activeProps[p];
      const varName = token.name + '/' + prop.suffix;

      let variable = existingByName[varName];
      if (variable) {
        updated++;
      } else {
        variable = createVariable(varName, collection, prop.type);
        variable.scopes = scopesFor(prop.key);
        existingByName[varName] = variable;
        created++;
      }

      // Write a value for every breakpoint mode we successfully have.
      for (var m = 0; m < modes.length; m++) {
        const mode = modes[m];
        const modeId = modeIds[mode.key];
        if (!modeId) continue;

        const bpValues = token.values && token.values[mode.key];
        if (!bpValues) continue;

        let raw = bpValues[prop.key];
        if (raw === undefined || raw === null || raw === '') continue;

        if (prop.type === 'FLOAT') {
          raw = round(Number(raw), decimals);
          if (isNaN(raw)) continue;
        } else {
          raw = String(raw);
        }

        variable.setValueForMode(modeId, raw);
      }
    }
  }

  return {
    collectionName: collectionName,
    created: created,
    updated: updated,
    modeWarnings: modeResult.warnings
  };
}

// Restrict where each variable can be applied, so the Figma UI offers them in
// the right spot when binding text properties.
function scopesFor(key) {
  switch (key) {
    case 'fontSize': return ['FONT_SIZE'];
    case 'lineHeight': return ['LINE_HEIGHT'];
    case 'letterSpacing': return ['LETTER_SPACING'];
    case 'fontWeight': return ['FONT_WEIGHT'];
    case 'fontFamily': return ['FONT_FAMILY'];
    default: return ['ALL_SCOPES'];
  }
}

// ---------------------------------------------------------------------------
// Import tokens from existing local text styles
// ---------------------------------------------------------------------------

async function importFromTextStyles() {
  const styles = await getLocalTextStyles();
  const tokens = styles.map(function (style) {
    const name = style.name;
    const fontSize = style.fontSize;
    const family = style.fontName && style.fontName.family;
    const styleName = style.fontName && style.fontName.style;
    const weight = weightFromStyleName(styleName);

    // Figma line height can be PIXELS, PERCENT or AUTO. Normalise to px.
    let lineHeight = fontSize;
    if (style.lineHeight && style.lineHeight.unit === 'PIXELS') {
      lineHeight = style.lineHeight.value;
    } else if (style.lineHeight && style.lineHeight.unit === 'PERCENT') {
      lineHeight = round(fontSize * style.lineHeight.value / 100, 2);
    }

    let letterSpacing = 0;
    if (style.letterSpacing && style.letterSpacing.unit === 'PIXELS') {
      letterSpacing = style.letterSpacing.value;
    } else if (style.letterSpacing && style.letterSpacing.unit === 'PERCENT') {
      letterSpacing = round(fontSize * style.letterSpacing.value / 100, 2);
    }

    return {
      name: name,
      fontFamily: family || 'Inter',
      fontWeight: weight,
      fontSize: fontSize,
      lineHeight: lineHeight,
      letterSpacing: letterSpacing
    };
  });

  return tokens;
}

function weightFromStyleName(styleName) {
  if (!styleName) return 400;
  const s = styleName.toLowerCase();
  if (s.indexOf('thin') !== -1) return 100;
  if (s.indexOf('extralight') !== -1 || s.indexOf('extra light') !== -1) return 200;
  if (s.indexOf('light') !== -1) return 300;
  if (s.indexOf('medium') !== -1) return 500;
  if (s.indexOf('semibold') !== -1 || s.indexOf('semi bold') !== -1) return 600;
  if (s.indexOf('extrabold') !== -1 || s.indexOf('extra bold') !== -1) return 800;
  if (s.indexOf('black') !== -1 || s.indexOf('heavy') !== -1) return 900;
  if (s.indexOf('bold') !== -1) return 700;
  return 400;
}

// ---------------------------------------------------------------------------
// Apply the right mode to selected frames based on their width
// ---------------------------------------------------------------------------

async function applyModesByWidth(payload) {
  const collectionName = payload.collectionName || 'Typography';
  const modes = payload.modes; // [{ key, name, width }] ordered largest -> smallest

  const collections = await getLocalCollections();
  const collection = collections.find(function (c) { return c.name === collectionName; });
  if (!collection) {
    return { error: 'No collection named "' + collectionName + '". Create the variables first.' };
  }

  const modeByName = {};
  collection.modes.forEach(function (m) { modeByName[m.name] = m.modeId; });

  const selection = figma.currentPage.selection;
  const frames = selection.filter(function (n) {
    return n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'INSTANCE' || n.type === 'SECTION';
  });

  if (frames.length === 0) {
    return { error: 'Select one or more frames first.' };
  }

  // Sort breakpoints from widest to narrowest so we can pick "first that fits".
  const ordered = modes.slice().sort(function (a, b) { return b.width - a.width; });

  let applied = 0;
  const details = [];
  frames.forEach(function (frame) {
    const width = frame.width;
    let chosen = ordered[ordered.length - 1]; // narrowest as fallback
    for (var i = 0; i < ordered.length; i++) {
      if (width >= ordered[i].width) { chosen = ordered[i]; break; }
    }
    const modeId = modeByName[chosen.name];
    if (!modeId) return;
    setExplicitMode(frame, collection, modeId);
    applied++;
    details.push(frame.name + ' (' + Math.round(width) + 'px) → ' + chosen.name);
  });

  return { applied: applied, details: details };
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

figma.ui.onmessage = async function (msg) {
  try {
    if (msg.type === 'create-variables') {
      const result = await createTypographyVariables(msg.payload);
      let note = 'Created ' + result.created + ' variable(s), updated ' + result.updated + '.';
      if (result.modeWarnings && result.modeWarnings.length) {
        note += ' Could not add modes: ' + result.modeWarnings.join(', ') +
          ' (multiple variable modes require a paid Figma plan).';
      }
      figma.notify(note);
      figma.ui.postMessage({ type: 'create-done', result: result });
      return;
    }

    if (msg.type === 'import-styles') {
      const tokens = await importFromTextStyles();
      figma.ui.postMessage({ type: 'import-done', tokens: tokens });
      if (tokens.length === 0) {
        figma.notify('No local text styles found in this file.');
      } else {
        figma.notify('Imported ' + tokens.length + ' text style(s).');
      }
      return;
    }

    if (msg.type === 'apply-modes') {
      const result = await applyModesByWidth(msg.payload);
      if (result.error) {
        figma.notify(result.error, { error: true });
      } else {
        figma.notify('Applied breakpoint mode to ' + result.applied + ' frame(s).');
      }
      figma.ui.postMessage({ type: 'apply-done', result: result });
      return;
    }

    if (msg.type === 'close') {
      figma.closePlugin();
      return;
    }
  } catch (err) {
    figma.notify('Error: ' + (err && err.message ? err.message : String(err)), { error: true });
    figma.ui.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
