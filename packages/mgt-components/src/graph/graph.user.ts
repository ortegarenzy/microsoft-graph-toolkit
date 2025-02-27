/**
 * -------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation.  All Rights Reserved.  Licensed under the MIT License.
 * See License in the project root for license information.
 * -------------------------------------------------------------------------------------------
 */

import { IGraph, prepScopes, CacheItem, CacheService, CacheStore } from '@microsoft/mgt-element';
import { User } from '@microsoft/microsoft-graph-types';

import { findPeople, PersonType } from './graph.people';
import { schemas } from './cacheStores';
import { UserType } from '..';
import { GraphRequest } from '@microsoft/microsoft-graph-client';

/**
 * Object to be stored in cache
 */
export interface CacheUser extends CacheItem {
  /**
   * stringified json representing a user
   */
  user?: string;
}

/**
 * Object to be stored in cache
 */
export interface CacheUserQuery extends CacheItem {
  /**
   * max number of results the query asks for
   */
  maxResults?: number;
  /**
   * list of users returned by query
   */
  results?: string[];
}

/**
 * Defines the time it takes for objects in the cache to expire
 */
export const getUserInvalidationTime = (): number =>
  CacheService.config.users.invalidationPeriod || CacheService.config.defaultInvalidationPeriod;

/**
 * Whether or not the cache is enabled
 */
export const getIsUsersCacheEnabled = (): boolean =>
  CacheService.config.users.isEnabled && CacheService.config.isEnabled;

export async function getUsers(graph: IGraph, userFilters: string = '', top: number = 10): Promise<User[]> {
  let apiString = '/users';
  let cache: CacheStore<CacheUserQuery>;
  const cacheKey = userFilters === '' ? '*' : userFilters;
  const cacheItem = { maxResults: top, results: null };

  if (getIsUsersCacheEnabled()) {
    cache = CacheService.getCache<CacheUserQuery>(schemas.users, schemas.users.stores.userFilters);
    const cacheRes = await cache.getValue(cacheKey);
    if (cacheRes && getUserInvalidationTime() > Date.now() - cacheRes.timeCached) {
      return cacheRes.results.map(userStr => JSON.parse(userStr));
    }
  }
  const graphClient: GraphRequest = graph.api(apiString).top(top);

  if (userFilters) {
    graphClient.filter(userFilters);
  }

  try {
    const response = await graphClient.middlewareOptions(prepScopes('user.read')).get();
    if (getIsUsersCacheEnabled() && response) {
      cacheItem.results = response.value.map(userStr => JSON.stringify(userStr));
      cache.putValue(userFilters, cacheItem);
    }
    return response.value;
  } catch (error) {}
}

/**
 * async promise, returns Graph User data relating to the user logged in
 *
 * @returns {(Promise<User>)}
 * @memberof Graph
 */
export async function getMe(graph: IGraph, requestedProps?: string[]): Promise<User> {
  let cache: CacheStore<CacheUser>;
  if (getIsUsersCacheEnabled()) {
    cache = CacheService.getCache<CacheUser>(schemas.users, schemas.users.stores.users);
    const me = await cache.getValue('me');

    if (me && getUserInvalidationTime() > Date.now() - me.timeCached) {
      const cachedData = JSON.parse(me.user);
      const uniqueProps = requestedProps
        ? requestedProps.filter(prop => !Object.keys(cachedData).includes(prop))
        : null;

      // if requestedProps doesn't contain any unique props other than "@odata.context"
      if (!uniqueProps || uniqueProps.length <= 1) {
        return cachedData;
      }
    }
  }

  let apiString = 'me';
  if (requestedProps) {
    apiString = apiString + '?$select=' + requestedProps.toString();
  }
  const response = graph.api(apiString).middlewareOptions(prepScopes('user.read')).get();
  if (getIsUsersCacheEnabled()) {
    cache.putValue('me', { user: JSON.stringify(await response) });
  }
  return response;
}

/**
 * async promise, returns all Graph users associated with the userPrincipleName provided
 *
 * @param {string} userPrincipleName
 * @returns {(Promise<User>)}
 * @memberof Graph
 */
export async function getUser(graph: IGraph, userPrincipleName: string, requestedProps?: string[]): Promise<User> {
  const scopes = 'user.readbasic.all';
  let cache: CacheStore<CacheUser>;

  if (getIsUsersCacheEnabled()) {
    cache = CacheService.getCache<CacheUser>(schemas.users, schemas.users.stores.users);
    // check cache
    const user = await cache.getValue(userPrincipleName);

    // is it stored and is timestamp good?
    if (user && getUserInvalidationTime() > Date.now() - user.timeCached) {
      const cachedData = user.user ? JSON.parse(user.user) : null;
      const uniqueProps =
        requestedProps && cachedData ? requestedProps.filter(prop => !Object.keys(cachedData).includes(prop)) : null;

      // return without any worries
      if (!uniqueProps || uniqueProps.length <= 1) {
        return cachedData;
      }
    }
  }

  let apiString = `/users/${userPrincipleName}`;
  if (requestedProps) {
    apiString = apiString + '?$select=' + requestedProps.toString();
  }

  // else we must grab it
  let response;
  try {
    response = await graph.api(apiString).middlewareOptions(prepScopes(scopes)).get();
  } catch (_) {}

  if (getIsUsersCacheEnabled()) {
    cache.putValue(userPrincipleName, { user: JSON.stringify(response) });
  }
  return response;
}

/**
 * Returns a Promise of Graph Users array associated with the user ids array
 *
 * @export
 * @param {IGraph} graph
 * @param {string[]} userIds, an array of string ids
 * @returns {Promise<User[]>}
 */
export async function getUsersForUserIds(
  graph: IGraph,
  userIds: string[],
  searchInput: string = '',
  userFilters: string = ''
): Promise<User[]> {
  if (!userIds || userIds.length === 0) {
    return [];
  }
  const batch = graph.createBatch();
  const peopleDict = {};
  const peopleSearchMatches = {};
  const notInCache = [];
  searchInput = searchInput.toLowerCase();
  let cache: CacheStore<CacheUser>;

  if (getIsUsersCacheEnabled()) {
    cache = CacheService.getCache<CacheUser>(schemas.users, schemas.users.stores.users);
  }

  for (const id of userIds) {
    peopleDict[id] = null;
    let user = null;
    if (getIsUsersCacheEnabled()) {
      user = await cache.getValue(id);
    }
    if (user && getUserInvalidationTime() > Date.now() - user.timeCached) {
      user = JSON.parse(user?.user);
      const displayName = user.displayName;

      if (searchInput) {
        const match = displayName && displayName.toLowerCase().includes(searchInput);
        const searchMatches = match ? true : false;
        if (searchMatches) {
          peopleSearchMatches[id] = user ? user : null;
        }
      } else {
        peopleDict[id] = user ? user : null;
      }
    } else if (id !== '') {
      if (id.toString() === 'me') {
        peopleDict[id] = await getMe(graph);
      } else {
        let apiUrl: string = `/users/${id}`;
        if (userFilters) {
          apiUrl += `${apiUrl}?$filter=${userFilters}`;
        }
        batch.get(id, apiUrl, ['user.readbasic.all']);
        notInCache.push(id);
      }
    }
  }
  try {
    const responses = await batch.executeAll();
    // iterate over userIds to ensure the order of ids
    for (const id of userIds) {
      const response = responses.get(id);
      if (response && response.content) {
        const user = response.content;
        if (searchInput) {
          const displayName = user?.displayName.toLowerCase();
          if (displayName.contains(searchInput)) {
            peopleSearchMatches[id] = user;
          }
        } else {
          peopleDict[id] = user;
        }

        if (getIsUsersCacheEnabled()) {
          cache.putValue(id, { user: JSON.stringify(user) });
        }
      }
    }
    if (searchInput && Object.keys(peopleSearchMatches).length) {
      return Promise.all(Object.values(peopleSearchMatches));
    }
    return Promise.all(Object.values(peopleDict));
  } catch (_) {
    // fallback to making the request one by one
    try {
      // call getUser for all the users that weren't cached
      userIds.filter(id => notInCache.includes(id)).forEach(id => (peopleDict[id] = getUser(graph, id)));
      if (getIsUsersCacheEnabled()) {
        // store all users that weren't retrieved from the cache, into the cache
        userIds
          .filter(id => notInCache.includes(id))
          .forEach(async id => cache.putValue(id, { user: JSON.stringify(await peopleDict[id]) }));
      }
      return Promise.all(Object.values(peopleDict));
    } catch (_) {
      return [];
    }
  }
}

/**
 * Returns a Promise of Graph Users array associated with the people queries array
 *
 * @export
 * @param {IGraph} graph
 * @param {string[]} peopleQueries, an array of string ids
 * @returns {Promise<User[]>}
 */
export async function getUsersForPeopleQueries(graph: IGraph, peopleQueries: string[]): Promise<User[]> {
  if (!peopleQueries || peopleQueries.length === 0) {
    return [];
  }

  const batch = graph.createBatch();
  const people = [];
  let cacheRes: CacheUserQuery;
  let cache: CacheStore<CacheUserQuery>;
  if (getIsUsersCacheEnabled()) {
    cache = CacheService.getCache<CacheUserQuery>(schemas.users, schemas.users.stores.usersQuery);
  }

  for (const personQuery of peopleQueries) {
    if (getIsUsersCacheEnabled()) {
      cacheRes = await cache.getValue(personQuery);
    }

    if (getIsUsersCacheEnabled() && cacheRes && getUserInvalidationTime() > Date.now() - cacheRes.timeCached) {
      people.push(JSON.parse(cacheRes.results[0]));
    } else if (personQuery !== '') {
      batch.get(personQuery, `/me/people?$search="${personQuery}"`, ['people.read']);
    }
  }

  try {
    const responses = await batch.executeAll();

    for (const personQuery of peopleQueries) {
      const response = responses.get(personQuery);
      if (response && response.content && response.content.value && response.content.value.length > 0) {
        people.push(response.content.value[0]);
        if (getIsUsersCacheEnabled()) {
          cache.putValue(personQuery, { maxResults: 1, results: [JSON.stringify(response.content.value[0])] });
        }
      } else {
        people.push(null);
      }
    }

    return people;
  } catch (_) {
    try {
      return Promise.all(
        peopleQueries
          .filter(personQuery => personQuery && personQuery !== '')
          .map(async personQuery => {
            const personArray = await findPeople(graph, personQuery, 1);
            if (personArray && personArray.length) {
              if (getIsUsersCacheEnabled()) {
                cache.putValue(personQuery, { maxResults: 1, results: [JSON.stringify(personArray[0])] });
              }
              return personArray[0];
            }
          })
      );
    } catch (_) {
      return [];
    }
  }
}

/**
 * Search Microsoft Graph for Users in the organization
 *
 * @export
 * @param {IGraph} graph
 * @param {string} query - the string to search for
 * @param {number} [top=10] - maximum number of results to return
 * @returns {Promise<User[]>}
 */
export async function findUsers(
  graph: IGraph,
  query: string,
  top: number = 10,
  userFilters: string = ''
): Promise<User[]> {
  const scopes = 'User.ReadBasic.All';
  const item = { maxResults: top, results: null };
  let cache: CacheStore<CacheUserQuery>;

  if (getIsUsersCacheEnabled()) {
    cache = CacheService.getCache<CacheUserQuery>(schemas.users, schemas.users.stores.usersQuery);
    const result: CacheUserQuery = await cache.getValue(query);

    if (result && getUserInvalidationTime() > Date.now() - result.timeCached) {
      return result.results.map(userStr => JSON.parse(userStr));
    }
  }

  let encodedQuery = `${query.replace(/#/g, '%2523')}`;
  let graphBuilder = graph
    .api('users')
    .header('ConsistencyLevel', 'eventual')
    .count(true)
    .search(`"displayName:${encodedQuery}" OR "mail:${encodedQuery}"`);
  let graphResult;

  if (userFilters !== '') {
    graphBuilder.filter(userFilters);
  }
  try {
    graphResult = await graphBuilder.top(top).middlewareOptions(prepScopes(scopes)).get();
  } catch {}

  if (getIsUsersCacheEnabled() && graphResult) {
    item.results = graphResult.value.map(userStr => JSON.stringify(userStr));
    cache.putValue(query, item);
  }
  return graphResult ? graphResult.value : null;
}

/**
 * async promise, returns all matching Graph users who are member of the specified group
 *
 * @param {string} query
 * @param {string} groupId - the group to query
 * @param {number} [top=10] - number of people to return
 * @param {PersonType} [personType=PersonType.person] - the type of person to search for
 * @param {boolean} [transitive=false] - whether the return should contain a flat list of all nested members
 * @returns {(Promise<User[]>)}
 */
export async function findGroupMembers(
  graph: IGraph,
  query: string,
  groupId: string,
  top: number = 10,
  personType: PersonType = PersonType.person,
  transitive: boolean = false,
  userFilters: string = '',
  peopleFilters: string = ''
): Promise<User[]> {
  const scopes = ['user.read.all', 'people.read'];
  const item = { maxResults: top, results: null };

  let cache: CacheStore<CacheUserQuery>;
  const key = `${groupId || '*'}:${query || '*'}:${personType}:${transitive}:${userFilters}`;

  if (getIsUsersCacheEnabled()) {
    cache = CacheService.getCache<CacheUserQuery>(schemas.users, schemas.users.stores.usersQuery);
    const result: CacheUserQuery = await cache.getValue(key);

    if (result && getUserInvalidationTime() > Date.now() - result.timeCached) {
      return result.results.map(userStr => JSON.parse(userStr));
    }
  }

  let filter: string = '';
  if (query) {
    filter = `startswith(displayName,'${query}') or startswith(givenName,'${query}') or startswith(surname,'${query}') or startswith(mail,'${query}') or startswith(userPrincipalName,'${query}')`;
  }

  let apiUrl: string = `/groups/${groupId}/${transitive ? 'transitiveMembers' : 'members'}`;
  if (personType === PersonType.person) {
    apiUrl += `/microsoft.graph.user`;
  } else if (personType === PersonType.group) {
    apiUrl += `/microsoft.graph.group`;
    if (query) {
      filter = `startswith(displayName,'${query}') or startswith(mail,'${query}')`;
    }
  }

  if (userFilters) {
    filter += query ? ` and ${userFilters}` : userFilters;
  }

  if (peopleFilters) {
    filter += query ? ` and ${peopleFilters}` : peopleFilters;
  }

  const graphResult = await graph
    .api(apiUrl)
    .count(true)
    .top(top)
    .filter(filter)
    .header('ConsistencyLevel', 'eventual')
    .middlewareOptions(prepScopes(...scopes))
    .get();

  if (getIsUsersCacheEnabled() && graphResult) {
    item.results = graphResult.value.map(userStr => JSON.stringify(userStr));
    cache.putValue(key, item);
  }

  return graphResult ? graphResult.value : null;
}

export async function findUsersFromGroupIds(
  graph: IGraph,
  query: string,
  groupIds: string[],
  top: number = 10,
  personType: PersonType = PersonType.person,
  transitive: boolean = false,
  groupFilters: string = ''
): Promise<User[]> {
  const users: User[] = [];
  for (let i = 0; i < groupIds.length; i++) {
    const groupId = groupIds[i];
    try {
      const groupUsers = await findGroupMembers(graph, query, groupId, top, personType, transitive, groupFilters);
      users.push(...groupUsers);
    } catch (_) {
      continue;
    }
  }
  return users;
}
