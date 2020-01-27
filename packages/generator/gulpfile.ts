/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as gulp from "gulp";
import { processApiFamily } from "./src/parser";
import {
  createClient,
  createDto,
  createIndex,
  createApiFamily,
  createApiIndex,
  renderOperationList
} from "./src/renderer";

import log from "fancy-log";
import del from "del";
import fs from "fs-extra";
import _ from "lodash";
import * as path from "path";

import {
  extractFiles,
  getBearer,
  searchExchange,
  downloadRestApis,
  RestApi
} from "@commerce-apps/exchange-connector";
import tmp from "tmp";

require("dotenv").config();

import { WebApiBaseUnitWithEncodesModel } from "webapi-parser";
import { model } from "amf-client-js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require("./build-config.json");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
gulp.task("clean", (cb: any) => {
  log.info(`Removing ${config.renderDir} directory`);
  return del([`${config.renderDir}`, "dist"], cb);
});

function search(): Promise<RestApi[]> {
  return getBearer(
    process.env.ANYPOINT_USERNAME,
    process.env.ANYPOINT_PASSWORD
  ).then(token => {
    return searchExchange(token, config.exchangeSearch);
  });
}

/**
 * Groups RAML files for the given key (API Family, a.k.a Bounded Context).
 * Once grouped, renderTemplates task creates one Client per group
 */
function downloadRamlFromExchange(): Promise<void> {
  const downloadDir = tmp.dirSync();
  return search().then(apis => {
    return downloadRestApis(apis, downloadDir.name)
      .then(folder => {
        console.log(`Setting config.inputDir to '${folder}'`);
        config.inputDir = folder;
        return extractFiles(folder);
      })
      .then(async () => {
        const ramlGroups = _.groupBy(apis, api => {
          // Categories are actually a list.
          // We are just going to use whatever the first one is for now
          if (config.apiFamily in api.categories) {
            return api.categories[config.apiFamily][0];
          } else {
            return "unclassified";
          }
        });
        fs.ensureDirSync(config.inputDir);
        return fs.writeFile(
          path.join(config.inputDir, config.apiConfigFile),
          JSON.stringify(ramlGroups)
        );
      });
    // Group RAML files by the key, aka, bounded context/API Family
  });
}

gulp.task("downloadRamlFromExchange", async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  if (process.env.EXCHANGE_DOWNLOAD) {
    console.log("Downloading apis from exchange");
    return downloadRamlFromExchange();
  } else {
    console.log("Not downloading so just using local files");
  }
});

/**
 * Returns API name from the AMF model
 * @param apiModel AMF Model of the API
 * @returns Name of the API
 */
function getApiName(apiModel: WebApiBaseUnitWithEncodesModel): string {
  const apiName: string = (apiModel.encodes as model.domain.WebApi).name.value();
  return _.upperFirst(_.camelCase(apiName));
}

/**
 * Renders API functions and its types into a typescript file
 * @param apiModel AMF Model of the API
 * @param inputDir Directory path at which the rendered API files are saved
 * @returns Name of the API
 */
function renderApi(
  apiModel: WebApiBaseUnitWithEncodesModel,
  inputDir: string
): string {
  const apiName: string = getApiName(apiModel);
  const apiPath: string = path.join(inputDir, apiName);
  fs.ensureDirSync(apiPath);
  //TODO: Modify createClient and createDto functions to take a single model object instead of array and get rid of apiModels array
  const apiModels: WebApiBaseUnitWithEncodesModel[] = [apiModel];
  fs.writeFileSync(
    path.join(apiPath, `${apiName}.ts`),
    createClient(apiModels, apiName)
  );
  fs.writeFileSync(
    path.join(apiPath, `${apiName}.types.ts`),
    createDto(apiModels)
  );
  fs.writeFileSync(path.join(apiPath, "index.ts"), createApiIndex(apiName));
  return apiName;
}

/**
 * Renders API functions and its types into a typescript file for all the APIs in a family
 * @param apiFamily Name of the API family
 * @param apiFamilyConfig Config of the API family
 * @param inputDir Directory path to save the rendered API files
 * @returns Promise<void>
 */
function renderApiFamily(
  apiFamily: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiFamilyConfig: any,
  inputDir: string
): Promise<void> {
  const apiFamilyPath: string = path.join(config.renderDir, apiFamily);
  fs.ensureDirSync(apiFamilyPath);

  const familyPromises = processApiFamily(apiFamily, apiFamilyConfig, inputDir);
  return Promise.all(familyPromises)
    .then(familyApis => {
      const apiNames: string[] = [];
      familyApis.forEach(api => {
        apiNames.push(
          renderApi(api as WebApiBaseUnitWithEncodesModel, apiFamilyPath)
        );
      });
      return apiNames;
    })
    .then(apiNames => {
      //export all apis in a family
      fs.writeFileSync(
        path.join(apiFamilyPath, `${apiFamily}.ts`),
        createApiFamily(apiNames)
      );
    });
}

/**
 * Renders typescript code for the APIs using the pre-defined templates
 * @returns Promise<void>
 */
function renderTemplates(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const apiFamilyRamlConfig = require(path.resolve(
    path.join(config.inputDir, config.apiConfigFile)
  ));
  const apiFamilyNames = _.keysIn(apiFamilyRamlConfig);
  const allPromises: Promise<void>[] = [];
  apiFamilyNames.forEach((apiFamily: string) => {
    allPromises.push(
      renderApiFamily(apiFamily, apiFamilyRamlConfig, config.inputDir)
    );
  });
  //create index file that exports all the api families in the root
  return Promise.all(allPromises).then(() => {
    fs.writeFileSync(
      path.join(config.renderDir, "index.ts"),
      createIndex(apiFamilyNames)
    );
  });
}

/**
 *  Gulp task that renders typescript code for the APIs using the pre-defined templates
 */
gulp.task(
  "renderTemplates",
  gulp.series(gulp.series("clean", "downloadRamlFromExchange"), async () => {
    return renderTemplates();
  })
);

gulp.task(
  "buildOperationList",
  gulp.series(gulp.series("clean", "downloadRamlFromExchange"), async () => {
    // require the json written in groupRamls gulpTask
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ramlGroupConfig = require(path.resolve(
      path.join(config.inputDir, config.apiConfigFile)
    ));
    const apiGroupKeys = _.keysIn(ramlGroupConfig);

    const allApis = {};

    const modelingPromises = [];

    for (const apiGroup of apiGroupKeys) {
      const familyPromises = processApiFamily(
        apiGroup,
        ramlGroupConfig,
        config.inputDir
      );
      fs.ensureDirSync(config.renderDir);

      modelingPromises.push(
        Promise.all(familyPromises).then(values => {
          allApis[apiGroup] = values;
          return;
        })
      );
    }

    return Promise.all(modelingPromises).then(() => {
      fs.writeFileSync(
        path.join(config.renderDir, "operationList.yaml"),
        renderOperationList(allApis)
      );
    });
  })
);
