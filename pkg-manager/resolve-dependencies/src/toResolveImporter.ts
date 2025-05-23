import { logger } from '@pnpm/logger'
import { getAllDependenciesFromManifest } from '@pnpm/manifest-utils'
import {
  type PreferredVersions,
  type WorkspacePackages,
} from '@pnpm/resolver-base'
import { type Dependencies, type ProjectManifest } from '@pnpm/types'
import getVerSelType from 'version-selector-type'
import { type ImporterToResolve } from '.'
import { getWantedDependencies, type WantedDependency } from './getWantedDependencies'
import { type ImporterToResolveGeneric } from './resolveDependencyTree'
import { safeIsInnerLink } from './safeIsInnerLink'
import { validatePeerDependencies } from './validatePeerDependencies'

export interface ResolveImporter extends ImporterToResolve, ImporterToResolveGeneric<{ isNew?: boolean }> {
  wantedDependencies: Array<WantedDependency & {
    isNew?: boolean
    updateDepth: number
  }>
}

export async function toResolveImporter (
  opts: {
    defaultUpdateDepth: number
    lockfileOnly: boolean
    preferredVersions?: PreferredVersions
    virtualStoreDir: string
    workspacePackages: WorkspacePackages
    updateToLatest?: boolean
    noDependencySelectors: boolean
  },
  project: ImporterToResolve
): Promise<ResolveImporter> {
  validatePeerDependencies(project)
  const allDeps = getWantedDependencies(project.manifest)
  const nonLinkedDependencies = await partitionLinkedPackages(allDeps, {
    lockfileOnly: opts.lockfileOnly,
    modulesDir: project.modulesDir,
    projectDir: project.rootDir,
    virtualStoreDir: opts.virtualStoreDir,
    workspacePackages: opts.workspacePackages,
  })
  const defaultUpdateDepth = (project.update === true || (project.updateMatching != null)) ? opts.defaultUpdateDepth : -1
  const existingDeps = nonLinkedDependencies
    .filter(({ alias }) => !project.wantedDependencies.some((wantedDep) => wantedDep.alias === alias))
  if (opts.updateToLatest && opts.noDependencySelectors) {
    for (const dep of existingDeps) {
      dep.updateSpec = true
    }
  }
  let wantedDependencies!: Array<WantedDependency & { isNew?: boolean, updateDepth: number }>
  if (!project.manifest) {
    wantedDependencies = [
      ...project.wantedDependencies,
      ...existingDeps,
    ]
      .map((dep) => ({
        ...dep,
        updateDepth: defaultUpdateDepth,
      }))
  } else {
    // Direct local tarballs are always checked,
    // so their update depth should be at least 0
    const updateLocalTarballs = (dep: WantedDependency) => ({
      ...dep,
      updateDepth: project.updateMatching != null
        ? defaultUpdateDepth
        : (prefIsLocalTarball(dep.bareSpecifier) ? 0 : defaultUpdateDepth),
    })
    wantedDependencies = [
      ...project.wantedDependencies.map(
        defaultUpdateDepth < 0
          ? updateLocalTarballs
          : (dep) => ({ ...dep, updateDepth: defaultUpdateDepth })),
      ...existingDeps.map(
        opts.noDependencySelectors && project.updateMatching != null
          ? updateLocalTarballs
          : (dep) => ({ ...dep, updateDepth: -1 })
      ),
    ]
  }
  return {
    ...project,
    hasRemovedDependencies: Boolean(project.removePackages?.length),
    preferredVersions: opts.preferredVersions ?? (project.manifest && getPreferredVersionsFromPackage(project.manifest)) ?? {},
    wantedDependencies,
  }
}

function prefIsLocalTarball (bareSpecifier: string): boolean {
  return bareSpecifier.startsWith('file:') && bareSpecifier.endsWith('.tgz')
}

async function partitionLinkedPackages (
  dependencies: WantedDependency[],
  opts: {
    projectDir: string
    lockfileOnly: boolean
    modulesDir: string
    virtualStoreDir: string
    workspacePackages?: WorkspacePackages
  }
): Promise<WantedDependency[]> {
  const nonLinkedDependencies: WantedDependency[] = []
  const linkedAliases = new Set<string>()
  await Promise.all(dependencies.map(async (dependency) => {
    if (
      !dependency.alias ||
      opts.workspacePackages?.get(dependency.alias) != null ||
      dependency.bareSpecifier.startsWith('workspace:')
    ) {
      nonLinkedDependencies.push(dependency)
      return
    }
    const isInnerLink = await safeIsInnerLink(opts.modulesDir, dependency.alias, {
      hideAlienModules: !opts.lockfileOnly,
      projectDir: opts.projectDir,
      virtualStoreDir: opts.virtualStoreDir,
    })
    if (isInnerLink === true) {
      nonLinkedDependencies.push(dependency)
      return
    }
    if (!dependency.bareSpecifier.startsWith('link:')) {
      // This info-log might be better to be moved to the reporter
      logger.info({
        message: `${dependency.alias} is linked to ${opts.modulesDir} from ${isInnerLink}`,
        prefix: opts.projectDir,
      })
    }
    linkedAliases.add(dependency.alias)
  }))
  return nonLinkedDependencies
}

function getPreferredVersionsFromPackage (
  pkg: Pick<ProjectManifest, 'devDependencies' | 'dependencies' | 'optionalDependencies'>
): PreferredVersions {
  return getVersionSpecsByRealNames(getAllDependenciesFromManifest(pkg))
}

type VersionSpecsByRealNames = Record<string, Record<string, 'version' | 'range' | 'tag'>>

function getVersionSpecsByRealNames (deps: Dependencies): VersionSpecsByRealNames {
  const acc: VersionSpecsByRealNames = {}
  for (const depName in deps) {
    const currentBareSpecifier = deps[depName]
    if (currentBareSpecifier.startsWith('npm:')) {
      const bareSpecifier = currentBareSpecifier.slice(4)
      const index = bareSpecifier.lastIndexOf('@')
      const spec = bareSpecifier.slice(index + 1)
      const selector = getVerSelType(spec)
      if (selector != null) {
        const pkgName = bareSpecifier.substring(0, index)
        acc[pkgName] = acc[pkgName] || {}
        acc[pkgName][selector.normalized] = selector.type
      }
    } else if (!currentBareSpecifier.includes(':')) { // we really care only about semver specs
      const selector = getVerSelType(currentBareSpecifier)
      if (selector != null) {
        acc[depName] = acc[depName] || {}
        acc[depName][selector.normalized] = selector.type
      }
    }
  }
  return acc
}
