// src/connectors/github-query.ts
// GitHub search connector: queries the GitHub search API.
// Spec 2 Plan 2-B Track A.

import type { GithubQueryConnectorConfig } from '../types/connectors';
import type { Connector, DecryptedSecret, DryRunResult, FetchedRecord } from './types';
import { ConnectorError } from './types';
import { errorToDryRunError, takeAsyncIter } from './_helpers';

const PER_PAGE = 100;
const GITHUB_API_BASE = 'https://api.github.com';

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: Array<Record<string, unknown>>;
}

export const githubQueryConnector: Connector = {
  async *fetch(
    config: unknown,
    secret: DecryptedSecret | null,
  ): AsyncGenerator<FetchedRecord> {
    const cfg = config as GithubQueryConnectorConfig;

    if (!secret?.value) {
      throw new ConnectorError(
        'MISSING_SECRET',
        'github_query connector requires a secret with a GitHub token',
      );
    }

    const maxResults = cfg.max_results ?? 100;
    let fetched = 0;
    let page = 1;

    while (fetched < maxResults) {
      const pageSize = Math.min(PER_PAGE, maxResults - fetched);
      const url = new URL(`${GITHUB_API_BASE}/search/${cfg.search_type}`);
      url.searchParams.set('q', cfg.query);
      url.searchParams.set('per_page', String(pageSize));
      url.searchParams.set('page', String(page));

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${secret.value}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
      } catch (err) {
        throw new ConnectorError(
          'UPSTREAM_UNREACHABLE',
          `Cannot reach GitHub API: ${(err as Error).message}`,
          err,
        );
      }

      if (response.status === 403) {
        throw new ConnectorError('UPSTREAM_RATE_LIMITED', 'GitHub API rate limit exceeded');
      }

      if (response.status === 422) {
        throw new ConnectorError('INVALID_QUERY', `Invalid GitHub search query: ${cfg.query}`);
      }

      if (!response.ok) {
        throw new ConnectorError(
          'UPSTREAM_ERROR',
          `GitHub API returned HTTP ${response.status}`,
        );
      }

      const data = (await response.json()) as GitHubSearchResponse;
      const items = data.items ?? [];

      for (const item of items) {
        const nodeId = item['node_id'];
        const stable_id = typeof nodeId === 'string' ? nodeId : String(item['id'] ?? '');
        yield { stable_id, raw: item };
        fetched++;
        if (fetched >= maxResults) return;
      }

      // No more pages
      if (items.length < pageSize) break;
      page++;
    }
  },

  async dryRun(config, secret): Promise<DryRunResult> {
    try {
      const sample = await takeAsyncIter(this.fetch(config, secret), 3);
      return { ok: true, sample_count: sample.length, sample };
    } catch (err) {
      return { ok: false, error: errorToDryRunError(err) };
    }
  },
};
