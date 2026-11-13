import { config } from '../../config';
import { PlankaAuth } from './auth';
import { PlankaHttp, mergeRequestPolicy, type RequestPolicy } from './http';

export { PlankaHttp, encodePath, type RequestOptions, type RequestPolicy } from './http';
export { PlankaAuth, type PlankaAuthConfig } from './auth';
export * from './errors';
export * from './types';

// Resource namespaces — fleshed out in Tasks 9–16.
// Adding a new resource is a one-line change here + a new file.
import { ProjectsResource } from './projects';
import { BoardsResource } from './boards';
import { ListsResource } from './lists';
import { CardsResource } from './cards';
import { CommentsResource } from './comments';
import { LabelsResource } from './labels';
import { TasksResource } from './tasks';
import { TaskListsResource } from './task-lists';
import { MembersResource } from './members';
import { CustomFieldsResource } from './custom-fields';
import { WebhooksResource } from './webhooks';

export class PlankaClient {
  readonly projects: ProjectsResource;
  readonly boards: BoardsResource;
  readonly lists: ListsResource;
  readonly cards: CardsResource;
  readonly comments: CommentsResource;
  readonly labels: LabelsResource;
  readonly tasks: TasksResource;
  readonly taskLists: TaskListsResource;
  readonly members: MembersResource;
  readonly customFields: CustomFieldsResource;
  readonly webhooks: WebhooksResource;

  private constructor(
    readonly http: PlankaHttp,
    readonly auth: PlankaAuth,
  ) {
    this.projects = new ProjectsResource(this.http);
    this.boards = new BoardsResource(this.http);
    this.lists = new ListsResource(this.http);
    this.cards = new CardsResource(this.http);
    this.comments = new CommentsResource(this.http);
    this.labels = new LabelsResource(this.http);
    this.tasks = new TasksResource(this.http);
    this.taskLists = new TaskListsResource(this.http);
    this.members = new MembersResource(this.http);
    this.customFields = new CustomFieldsResource(this.http);
    this.webhooks = new WebhooksResource(this.http);
  }

  static fromConfig(): PlankaClient {
    const auth = new PlankaAuth({
      baseUrl: config.services.planka.baseUrl,
      email: config.services.planka.email,
      password: config.services.planka.password,
      termsPath: config.services.planka.termsPath,
      acceptTermsPath: config.services.planka.acceptTermsPath,
      defaultLanguage: config.services.planka.defaultLanguage,
    });
    const http = new PlankaHttp(auth, config.services.planka.baseUrl);
    return new PlankaClient(http, auth);
  }

  /** Construct a PlankaClient from an already-wired http + auth. Used by tests. */
  static forTesting(http: PlankaHttp, auth: PlankaAuth): PlankaClient {
    return new PlankaClient(http, auth);
  }

  asAgent(): PlankaClient {
    return new PlankaClient(this.http, this.auth);
  }

  /**
   * The same account and token cache, with `policy` applied to every
   * request this client makes (see http.ts RequestPolicy). Per-caller: the
   * process singleton and every other client keep the global behaviour.
   */
  withRequestPolicy(policy: RequestPolicy): PlankaClient {
    const http = new PlankaHttp(this.auth, this.http.baseUrl, mergeRequestPolicy(this.http.policy, policy));
    return new PlankaClient(http, this.auth);
  }
}

/**
 * Process-level singleton. fr acts in Planka as ONE configured account
 * (config.services.planka); resource namespaces are fresh on each asAgent()
 * call, but HTTP and auth (and the token cache) are shared.
 */
export const plankaClient = PlankaClient.fromConfig();
