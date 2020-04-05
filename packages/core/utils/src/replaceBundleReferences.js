// @flow strict-local

import type SourceMap from '@parcel/source-map';
import type {Async, Blob, Bundle, BundleGraph, Dependency} from '@parcel/types';

import {Readable} from 'stream';
import nullthrows from 'nullthrows';
import URL from 'url';
import {bufferStream, relativeBundlePath, urlJoin} from '../';

type ReplacementMap = Map<
  string /* dependency id */,
  {|from: string, to: string|},
>;

/*
 * Replaces references to dependency ids for URL dependencies with:
 *   - in the case of an unresolvable url dependency, the original moduleSpecifier.
 *     These are external requests that Parcel did not bundle.
 *   - in the case of a reference to another bundle, the relative url to that
 *     bundle from the current bundle.
 */
export function replaceURLReferences({
  bundle,
  bundleGraph,
  contents,
  map,
  relative = true,
}: {|
  bundle: Bundle,
  bundleGraph: BundleGraph,
  contents: string,
  relative?: boolean,
  map?: ?SourceMap,
|}): {|+contents: string, +map: ?SourceMap|} {
  let replacements = new Map();

  for (let dependency of bundleGraph.getExternalDependencies(bundle)) {
    if (!dependency.isURL) {
      continue;
    }

    let bundleGroup = bundleGraph.resolveExternalDependency(dependency);
    if (bundleGroup == null) {
      replacements.set(dependency.id, {
        from: dependency.id,
        to: dependency.moduleSpecifier,
      });
      continue;
    }

    let [entryBundle] = bundleGraph.getBundlesInBundleGroup(bundleGroup);
    if (entryBundle.isInline) {
      // If a bundle is inline, it should be replaced with inline contents,
      // not a URL.
      continue;
    }

    replacements.set(
      dependency.id,
      getURLReplacement({
        dependency,
        fromBundle: bundle,
        toBundle: entryBundle,
        relative,
      }),
    );
  }

  return performReplacement(replacements, contents, map);
}

/*
 * Replaces references to dependency ids for inline bundles with the packaged
 * contents of that bundle.
 */
export async function replaceInlineReferences({
  bundle,
  bundleGraph,
  contents,
  map,
  getInlineReplacement,
  getInlineBundleContents,
}: {|
  bundle: Bundle,
  bundleGraph: BundleGraph,
  contents: string,
  getInlineReplacement: (
    Dependency,
    ?'string',
    string,
  ) => {|from: string, to: string|},
  getInlineBundleContents: (Bundle, BundleGraph) => Async<{|contents: Blob|}>,
  map?: ?SourceMap,
|}): Promise<{|+contents: string, +map: ?SourceMap|}> {
  let replacements = new Map();

  for (let dependency of bundleGraph.getExternalDependencies(bundle)) {
    let bundleGroup = bundleGraph.resolveExternalDependency(dependency);
    if (bundleGroup == null) {
      continue;
    }

    let [entryBundle] = bundleGraph.getBundlesInBundleGroup(bundleGroup);
    if (!entryBundle.isInline) {
      continue;
    }

    let packagedBundle = await getInlineBundleContents(
      entryBundle,
      bundleGraph,
    );
    let packagedContents = (packagedBundle.contents instanceof Readable
      ? await bufferStream(packagedBundle.contents)
      : packagedBundle.contents
    ).toString();

    let inlineType = nullthrows(entryBundle.getMainEntry()).meta.inlineType;
    if (inlineType == null || inlineType === 'string') {
      replacements.set(
        dependency.id,
        getInlineReplacement(dependency, inlineType, packagedContents),
      );
    }
  }

  return performReplacement(replacements, contents, map);
}

function getURLReplacement({
  dependency,
  fromBundle,
  toBundle,
  relative,
}: {|
  dependency: Dependency,
  fromBundle: Bundle,
  toBundle: Bundle,
  relative: boolean,
|}) {
  let to;
  if (relative) {
    to = URL.format({
      pathname: relativeBundlePath(fromBundle, toBundle, {
        leadingDotSlash: false,
      }),
    });
  } else {
    to = urlJoin(
      toBundle.target.publicUrl,
      URL.format({pathname: nullthrows(toBundle.name)}),
    );
  }

  return {
    from: dependency.id,
    to,
  };
}

function performReplacement(
  replacements: ReplacementMap,
  contents: string,
  map?: ?SourceMap,
): {|+contents: string, +map: ?SourceMap|} {
  let finalContents = contents;
  for (let {from, to} of replacements.values()) {
    // Perform replacement
    finalContents = finalContents.split(from).join(to);
  }

  return {
    contents: finalContents,
    // TODO: Update sourcemap with adjusted contents
    map,
  };
}
