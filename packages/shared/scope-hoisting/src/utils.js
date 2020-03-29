// @flow
import type {Asset, MutableAsset, Bundle, BundleGraph} from '@parcel/types';
import type {Diagnostic} from '@parcel/diagnostic';
import type {Node} from '@babel/types';

import ThrowableDiagnostic from '@parcel/diagnostic';
import * as t from '@babel/types';
import invariant from 'assert';

export function getName(
  asset: Asset | MutableAsset,
  type: string,
  ...rest: Array<string>
) {
  return (
    '$' +
    t.toIdentifier(asset.id) +
    '$' +
    type +
    (rest.length
      ? '$' +
        rest
          .map(name => (name === 'default' ? name : t.toIdentifier(name)))
          .join('$')
      : '')
  );
}

export function getIdentifier(
  asset: Asset | MutableAsset,
  type: string,
  ...rest: Array<string>
) {
  return t.identifier(getName(asset, type, ...rest));
}

export function getExportIdentifier(asset: Asset | MutableAsset, name: string) {
  return getIdentifier(asset, 'export', name);
}

export function needsPrelude(bundle: Bundle, bundleGraph: BundleGraph) {
  if (bundle.env.outputFormat !== 'global') {
    return false;
  }

  // If this is an entry bundle and it is referenced by other bundles,
  // we need to add the prelude code, which allows registering modules dynamically at runtime.
  return isEntry(bundle, bundleGraph) && isReferenced(bundle, bundleGraph);
}

export function isEntry(bundle: Bundle, bundleGraph: BundleGraph) {
  // If there is no parent JS bundle (e.g. in an HTML page), or environment is isolated (e.g. worker)
  // then this bundle is an "entry"
  return (
    !bundleGraph.hasParentBundleOfType(bundle, 'js') || bundle.env.isIsolated()
  );
}

export function isReferenced(bundle: Bundle, bundleGraph: BundleGraph) {
  // A bundle is potentially referenced if there are any child or sibling JS bundles that are not isolated
  return [
    ...bundleGraph.getChildBundles(bundle),
    ...bundleGraph.getSiblingBundles(bundle),
  ].some(
    b => b.type === 'js' && (!b.env.isIsolated() || bundle.env.isIsolated()),
  );
}

export function assertString(v: mixed): string {
  invariant(typeof v === 'string');
  return v;
}

export function getThrowableDiagnosticForNode(
  message: string,
  filePath: string,
  node: Node,
) {
  let diagnostic: Diagnostic = {
    message,
    filePath: filePath,
    language: 'js',
  };
  if (node.loc) {
    diagnostic.codeFrame = {
      codeHighlights: {
        start: {
          line: node.loc.start.line,
          column: node.loc.start.column + 1,
        },
        // These two cancel out:
        // - Babel's columns are exclusive, ours are inclusive
        // - Babel has 0-based columns, ours are 1-based
        end: node.loc.end,
      },
    };
  }
  return new ThrowableDiagnostic({
    diagnostic,
  });
}
