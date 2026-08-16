// Typography & Layout Breakpoint Variables — Figma plugin (main thread)
// ---------------------------------------------------------------------------
// Builds responsive Variable Collections with one MODE per breakpoint
// (Desktop / Tablet / Mobile):
//   • Typography  — per token: fontSize, lineHeight, letterSpacing, weight, family
//   • Layout      — spacing, sizing and corner-radius scalars
// It can also BIND selected element fields (width, height, padding, gap, radius)
// to those variables, apply the right mode to frames by their width, and set
// auto-layout alignment on a selection.
//
// Runs in the Figma plugin sandbox. UI lives in ui.html.
// ---------------------------------------------------------------------------

figma.showUI(__html__, { width: 480, height: 740, themeColors: true });

// ---------------------------------------------------------------------------
// Compatibility helpers (Variables API signatures changed across versions).
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

function bindVariable(node, field, variable) {
  // Newer API takes the Variable object; older took its id.
  try {
    node.setBoundVariable(field, variable);
  } catch (err) {
    node.setBoundVariable(field, variable.id);
  }
}

function round(value, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// ---------------------------------------------------------------------------
// Collection / mode setup
// ---------------------------------------------------------------------------

async function getOrCreateCollection(name) {
  const collections = await getLocalCollections();
  const existing = collections.find(function (c) { return c.name === name; });
  if (existing) return existing;
  return figma.variables.createVariableCollection(name);
}

// Ensure one mode per breakpoint. Returns { modeIds: {key->id}, warnings: [] }.
function ensureModes(collection, modes) {
  const result = {};
  const warnings = [];
  modes.forEach(function (mode, index) {
    const wanted = mode.name;
    const already = collection.modes.find(function (m) { return m.name === wanted; });
    if (already) { result[mode.key] = already.modeId; return; }
    if (index === 0) {
      const first = collection.modes[0];
      collection.renameMode(first.modeId, wanted);
      result[mode.key] = first.modeId;
      return;
    }
    try {
      result[mode.key] = collection.addMode(wanted);
    } catch (err) {
      warnings.push(wanted);
    }
  });
  return { modeIds: result, warnings: warnings };
}

function scopesFor(key) {
  switch (key) {
    case 'fontSize': return ['FONT_SIZE'];
    case 'lineHeight': return ['LINE_HEIGHT'];
    case 'letterSpacing': return ['LETTER_SPACING'];
    case 'fontWeight': return ['FONT_WEIGHT'];
    case 'fontFamily': return ['FONT_FAMILY'];
    case 'spacing': return ['GAP'];
    case 'size': return ['WIDTH_HEIGHT'];
    case 'radius': return ['CORNER_RADIUS'];
    default: return ['ALL_SCOPES'];
  }
}

// ---------------------------------------------------------------------------
// Typography variables — several properties per token
// ---------------------------------------------------------------------------

var TYPO_PROPS = [
  { key: 'fontFamily', suffix: 'fontFamily', type: 'STRING' },
  { key: 'fontWeight', suffix: 'fontWeight', type: 'FLOAT' },
  { key: 'fontSize', suffix: 'fontSize', type: 'FLOAT' },
  { key: 'lineHeight', suffix: 'lineHeight', type: 'FLOAT' },
  { key: 'letterSpacing', suffix: 'letterSpacing', type: 'FLOAT' }
];

async function createTypographyVariables(payload) {
  const collectionName = payload.collectionName || 'Typography';
  const modes = payload.modes;
  const tokens = payload.tokens;
  const enabled = payload.properties || {};
  const decimals = typeof payload.decimals === 'number' ? payload.decimals : 2;

  const collection = await getOrCreateCollection(collectionName);
  const modeResult = ensureModes(collection, modes);
  const modeIds = modeResult.modeIds;

  const allVars = await getLocalVariables();
  const existingByName = {};
  allVars.forEach(function (v) {
    if (v.variableCollectionId === collection.id) existingByName[v.name] = v;
  });

  const activeProps = TYPO_PROPS.filter(function (p) { return enabled[p.key] !== false; });
  let created = 0, updated = 0;

  for (var t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (!token.name) continue;
    for (var p = 0; p < activeProps.length; p++) {
      const prop = activeProps[p];
      const varName = token.name + '/' + prop.suffix;
      let variable = existingByName[varName];
      if (variable) { updated++; }
      else {
        variable = createVariable(varName, collection, prop.type);
        variable.scopes = scopesFor(prop.key);
        existingByName[varName] = variable;
        created++;
      }
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
        } else { raw = String(raw); }
        variable.setValueForMode(modeId, raw);
      }
    }
  }
  return { collectionName: collectionName, created: created, updated: updated, modeWarnings: modeResult.warnings };
}

// ---------------------------------------------------------------------------
// Scalar variables — one FLOAT variable per token (spacing / sizing / radius)
// ---------------------------------------------------------------------------

async function createScalarVariables(payload) {
  const collectionName = payload.collectionName || 'Layout';
  const modes = payload.modes;
  const tokens = payload.tokens; // [{ name, group, values: { modeKey: number } }]
  const decimals = typeof payload.decimals === 'number' ? payload.decimals : 2;

  const collection = await getOrCreateCollection(collectionName);
  const modeResult = ensureModes(collection, modes);
  const modeIds = modeResult.modeIds;

  const allVars = await getLocalVariables();
  const existingByName = {};
  allVars.forEach(function (v) {
    if (v.variableCollectionId === collection.id) existingByName[v.name] = v;
  });

  let created = 0, updated = 0;
  for (var t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (!token.name) continue;
    const varName = token.name;
    let variable = existingByName[varName];
    if (variable) { updated++; }
    else {
      variable = createVariable(varName, collection, 'FLOAT');
      variable.scopes = scopesFor(token.group || 'size');
      existingByName[varName] = variable;
      created++;
    }
    for (var m = 0; m < modes.length; m++) {
      const mode = modes[m];
      const modeId = modeIds[mode.key];
      if (!modeId) continue;
      let raw = token.values && token.values[mode.key];
      if (raw === undefined || raw === null || raw === '') continue;
      raw = round(Number(raw), decimals);
      if (isNaN(raw)) continue;
      variable.setValueForMode(modeId, raw);
    }
  }
  return { collectionName: collectionName, created: created, updated: updated, modeWarnings: modeResult.warnings };
}

// ---------------------------------------------------------------------------
// Import tokens from existing local text styles
// ---------------------------------------------------------------------------

async function importFromTextStyles() {
  const styles = await getLocalTextStyles();
  return styles.map(function (style) {
    const fontSize = style.fontSize;
    let lineHeight = fontSize;
    if (style.lineHeight && style.lineHeight.unit === 'PIXELS') lineHeight = style.lineHeight.value;
    else if (style.lineHeight && style.lineHeight.unit === 'PERCENT') lineHeight = round(fontSize * style.lineHeight.value / 100, 2);
    let letterSpacing = 0;
    if (style.letterSpacing && style.letterSpacing.unit === 'PIXELS') letterSpacing = style.letterSpacing.value;
    else if (style.letterSpacing && style.letterSpacing.unit === 'PERCENT') letterSpacing = round(fontSize * style.letterSpacing.value / 100, 2);
    return {
      name: style.name,
      fontFamily: (style.fontName && style.fontName.family) || 'Inter',
      fontWeight: weightFromStyleName(style.fontName && style.fontName.style),
      fontSize: fontSize,
      lineHeight: lineHeight,
      letterSpacing: letterSpacing
    };
  });
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
// Bind local TEXT STYLES to the typography variables (by matching name), so the
// global styles themselves become responsive: a text using "heading/h1" shows
// the Desktop value on a Desktop-mode frame and the Mobile value on a Mobile one.
// ---------------------------------------------------------------------------

// Text-style fields we bind and the matching variable-name suffix.
var STYLE_FIELD_MAP = [
  { field: 'fontSize', suffix: 'fontSize' },
  { field: 'lineHeight', suffix: 'lineHeight' },
  { field: 'letterSpacing', suffix: 'letterSpacing' }
];

function bindStyleVariable(style, field, variable) {
  try {
    style.setBoundVariable(field, variable);
  } catch (err) {
    style.setBoundVariable(field, variable.id);
  }
}

async function bindTextStyles(payload) {
  const collectionName = payload.collectionName || 'Typography';
  const fields = payload.fields || ['fontSize', 'lineHeight', 'letterSpacing'];

  const collections = await getLocalCollections();
  const collection = collections.find(function (c) { return c.name === collectionName; });
  if (!collection) {
    return { error: 'Collection "' + collectionName + '" not found. Create the variables first.' };
  }

  const vars = await getLocalVariables();
  const varsInColl = {};
  vars.forEach(function (v) {
    if (v.variableCollectionId === collection.id) varsInColl[v.name] = v;
  });

  const styles = await getLocalTextStyles();
  if (styles.length === 0) return { error: 'No local text styles found in this file.' };

  let bound = 0;
  const missing = [];
  let supported = true;

  for (var i = 0; i < styles.length; i++) {
    const style = styles[i];
    if (typeof style.setBoundVariable !== 'function') { supported = false; break; }

    let anyOnStyle = false;
    for (var f = 0; f < STYLE_FIELD_MAP.length; f++) {
      const map = STYLE_FIELD_MAP[f];
      if (fields.indexOf(map.field) === -1) continue;
      const variable = varsInColl[style.name + '/' + map.suffix];
      if (!variable) continue;
      try {
        bindStyleVariable(style, map.field, variable);
        anyOnStyle = true;
      } catch (err) { /* field not bindable */ }
    }
    if (anyOnStyle) bound++;
    else missing.push(style.name);
  }

  if (!supported) {
    return { error: 'This Figma version cannot bind variables to text styles via the API. Update the desktop app, or bind them manually in the text-style editor.' };
  }

  return { bound: bound, missing: missing, total: styles.length };
}

// ---------------------------------------------------------------------------
// Apply the right mode to selected frames based on their width.
// Sets the mode on EVERY listed collection so both type and layout switch.
// ---------------------------------------------------------------------------

async function applyModesByWidth(payload) {
  const collectionNames = payload.collectionNames || ['Typography'];
  const modes = payload.modes;

  const collections = await getLocalCollections();
  const targets = collections.filter(function (c) { return collectionNames.indexOf(c.name) !== -1; });
  if (targets.length === 0) {
    return { error: 'No matching collections found. Create the variables first.' };
  }

  const selection = figma.currentPage.selection;
  const frames = selection.filter(function (n) {
    return n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' ||
           n.type === 'INSTANCE' || n.type === 'SECTION' || n.type === 'GROUP';
  });
  if (frames.length === 0) return { error: 'Select one or more frames first.' };

  const ordered = modes.slice().sort(function (a, b) { return b.width - a.width; });

  let applied = 0;
  const details = [];
  frames.forEach(function (frame) {
    const width = frame.width;
    let chosen = ordered[ordered.length - 1];
    for (var i = 0; i < ordered.length; i++) {
      if (width >= ordered[i].width) { chosen = ordered[i]; break; }
    }
    let didAny = false;
    targets.forEach(function (collection) {
      const mode = collection.modes.find(function (m) { return m.name === chosen.name; });
      if (!mode) return;
      setExplicitMode(frame, collection, mode.modeId);
      didAny = true;
    });
    if (didAny) {
      applied++;
      details.push(frame.name + ' (' + Math.round(width) + 'px) → ' + chosen.name);
    }
  });
  return { applied: applied, details: details };
}

// ---------------------------------------------------------------------------
// List variables so the UI can offer them for binding.
// ---------------------------------------------------------------------------

async function listVariables() {
  const collections = await getLocalCollections();
  const nameById = {};
  collections.forEach(function (c) { nameById[c.id] = c.name; });
  const vars = await getLocalVariables();
  return vars.map(function (v) {
    return { name: v.name, type: v.resolvedType, collection: nameById[v.variableCollectionId] || '' };
  });
}

// ---------------------------------------------------------------------------
// Bind selected nodes' fields to a variable.
// ---------------------------------------------------------------------------

// Logical target -> concrete Figma node fields.
var FIELD_MAP = {
  width: ['width'],
  height: ['height'],
  minWidth: ['minWidth'],
  maxWidth: ['maxWidth'],
  minHeight: ['minHeight'],
  maxHeight: ['maxHeight'],
  paddingAll: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  paddingTop: ['paddingTop'],
  paddingRight: ['paddingRight'],
  paddingBottom: ['paddingBottom'],
  paddingLeft: ['paddingLeft'],
  gap: ['itemSpacing'],
  radiusAll: ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'],
  radiusTopLeft: ['topLeftRadius'],
  radiusTopRight: ['topRightRadius'],
  radiusBottomRight: ['bottomRightRadius'],
  radiusBottomLeft: ['bottomLeftRadius']
};

async function bindSelection(payload) {
  const target = payload.target;      // logical key from FIELD_MAP
  const varName = payload.variableName;
  const collectionName = payload.collectionName;

  const fields = FIELD_MAP[target];
  if (!fields) return { error: 'Unknown field: ' + target };

  const collections = await getLocalCollections();
  const collection = collections.find(function (c) { return c.name === collectionName; });
  if (!collection) return { error: 'Collection "' + collectionName + '" not found.' };

  const vars = await getLocalVariables();
  const variable = vars.find(function (v) {
    return v.name === varName && v.variableCollectionId === collection.id;
  });
  if (!variable) return { error: 'Variable "' + varName + '" not found.' };

  const selection = figma.currentPage.selection;
  if (selection.length === 0) return { error: 'Select one or more elements first.' };

  let bound = 0;
  const skipped = [];
  selection.forEach(function (node) {
    let anyOnNode = false;
    fields.forEach(function (field) {
      // Only bind fields the node actually supports.
      if (!(field in node)) return;
      // Padding / gap require an auto-layout frame.
      if ((field.indexOf('padding') === 0 || field === 'itemSpacing') &&
          !('layoutMode' in node && node.layoutMode !== 'NONE')) {
        return;
      }
      try {
        bindVariable(node, field, variable);
        anyOnNode = true;
      } catch (err) { /* field not bindable on this node */ }
    });
    if (anyOnNode) bound++;
    else skipped.push(node.name);
  });

  return { bound: bound, skipped: skipped, target: target, variable: varName };
}

// ---------------------------------------------------------------------------
// Auto-layout alignment (NOT variable-driven — enums can't be variables).
// ---------------------------------------------------------------------------

async function applyAlignment(payload) {
  const primary = payload.primary;   // 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' | ''
  const counter = payload.counter;   // 'MIN' | 'CENTER' | 'MAX' | 'BASELINE' | ''

  const selection = figma.currentPage.selection;
  if (selection.length === 0) return { error: 'Select one or more elements first.' };

  let applied = 0;
  const skipped = [];
  selection.forEach(function (node) {
    if (!('layoutMode' in node) || node.layoutMode === 'NONE') {
      skipped.push(node.name);
      return;
    }
    if (primary) node.primaryAxisAlignItems = primary;
    if (counter) node.counterAxisAlignItems = counter;
    applied++;
  });
  return { applied: applied, skipped: skipped };
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

figma.ui.onmessage = async function (msg) {
  try {
    if (msg.type === 'create-variables') {
      const result = await createTypographyVariables(msg.payload);
      let note = 'Typography: ' + result.created + ' created, ' + result.updated + ' updated.';
      if (result.modeWarnings && result.modeWarnings.length) {
        note += ' Could not add modes: ' + result.modeWarnings.join(', ') + ' (paid plan required).';
      }
      figma.notify(note);
      figma.ui.postMessage({ type: 'create-done', result: result });
      return;
    }

    if (msg.type === 'create-layout') {
      const result = await createScalarVariables(msg.payload);
      let note = 'Layout: ' + result.created + ' created, ' + result.updated + ' updated.';
      if (result.modeWarnings && result.modeWarnings.length) {
        note += ' Could not add modes: ' + result.modeWarnings.join(', ') + ' (paid plan required).';
      }
      figma.notify(note);
      figma.ui.postMessage({ type: 'create-layout-done', result: result });
      return;
    }

    if (msg.type === 'import-styles') {
      const tokens = await importFromTextStyles();
      figma.ui.postMessage({ type: 'import-done', tokens: tokens });
      figma.notify(tokens.length ? ('Imported ' + tokens.length + ' text style(s).') : 'No local text styles found.');
      return;
    }

    if (msg.type === 'bind-text-styles') {
      const result = await bindTextStyles(msg.payload);
      if (result.error) figma.notify(result.error, { error: true });
      else figma.notify('Bound variables on ' + result.bound + ' of ' + result.total + ' text style(s).');
      figma.ui.postMessage({ type: 'bind-styles-done', result: result });
      return;
    }

    if (msg.type === 'apply-modes') {
      const result = await applyModesByWidth(msg.payload);
      if (result.error) figma.notify(result.error, { error: true });
      else figma.notify('Applied breakpoint mode to ' + result.applied + ' frame(s).');
      figma.ui.postMessage({ type: 'apply-done', result: result });
      return;
    }

    if (msg.type === 'list-variables') {
      const variables = await listVariables();
      figma.ui.postMessage({ type: 'variables-list', variables: variables });
      return;
    }

    if (msg.type === 'bind-selection') {
      const result = await bindSelection(msg.payload);
      if (result.error) figma.notify(result.error, { error: true });
      else figma.notify('Bound "' + result.variable + '" on ' + result.bound + ' element(s).');
      figma.ui.postMessage({ type: 'bind-done', result: result });
      return;
    }

    if (msg.type === 'apply-align') {
      const result = await applyAlignment(msg.payload);
      if (result.error) figma.notify(result.error, { error: true });
      else figma.notify('Alignment applied to ' + result.applied + ' auto-layout frame(s).');
      figma.ui.postMessage({ type: 'align-done', result: result });
      return;
    }

    if (msg.type === 'close') {
      figma.closePlugin();
      return;
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    figma.notify('Error: ' + message, { error: true });
    figma.ui.postMessage({ type: 'error', message: message });
  }
};
