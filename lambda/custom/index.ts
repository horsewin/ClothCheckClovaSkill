'use strict';

import * as Clova from '@line/clova-cek-sdk-nodejs';
import axios, {AxiosRequestConfig} from 'axios';
import {DocumentClient} from 'aws-sdk/clients/dynamodb';
import * as line from '@line/bot-sdk';
import * as Types from "@line/bot-sdk/lib/types";
import {TemplateContent} from "@line/bot-sdk/lib/types";
import {quickReply} from "./botResponse";

// ------------------------------------------------------
// 変数・定数定義
// ------------------------------------------------------
const AWS = require('aws-sdk');
const util = require('util');
const MESSAGE = require('./message');
const POSTALCODE_TABLE = 'ClothCheckPostalCodeForUser';
const USERTEMPERATURE_TABLE = 'ClothCheckTempForUser';
const COUNTRYCODE = 'JP';
const REGION = 'ap-northeast-1';

// セッション状態
const enum STATE {
  ASK_POSTALCODE_FIRST = 'postal-first',
  ASK_POSTALCODE_REST = 'postal-rest',
  ASK_TEMPERATURE = 'input',
}

const enum RESULT {
  HOT = 'あつい',
  COLD = 'さむい',
  GOOD = 'ちょうどいい',
}

AWS.config.update({
  region: REGION,
});
const documentClient = new AWS.DynamoDB.DocumentClient({apiVersion: 'latest'});

const lineSDKConfig = {
  channelAccessToken: process.env.ACCESSTOKEN as string,
};
const lineClient = new line.Client(lineSDKConfig);

// ------------------------------------------------------
// API定義
// ------------------------------------------------------
const config: AxiosRequestConfig = {
  method: 'get',
  baseURL: 'http://api.openweathermap.org/',
  timeout: 10000,
  responseType: 'json',
  validateStatus: (status: number) => status >= 200 && status < 300,
};

/**
 *
 * @param event
 * @param content
 */
exports.handler = async (event: any, content: any) => {
  console.log(JSON.stringify(event, null, 2));

  const signature = event.headers.signaturecek || event.headers.SignatureCEK;
  const applicationId = process.env.APPLICATION_ID as string;
  const requestBody = event.body;

  // ヘッダーとスキルのExtensionIdとリクエストボディで検証
  await Clova.verifier(signature, applicationId, requestBody);

  // 「Lambdaプロキシの結合」を有効にするとCEKからのJSONの中身は「event.body」で文字列で取得できる。
  const body = JSON.parse(event.body);
  if (process.env.DEBUG === '1') {
    body.session.user.userId = process.env.MYID;
  }

  const ctx = new Clova.Context(body);
  const requestType = ctx.requestObject.request.type;
  const requestHandler = clovaSkillHandler.config.requestHandlers[requestType];

  if (requestHandler) {
    await requestHandler.call(ctx, ctx);
    console.log(ctx.responseObject);

    // 　CEKに返すレスポンス
    const response = {
      isBase64Encoded: false,
      statusCode: 200,
      headers: {},
      body: JSON.stringify(ctx.responseObject),
    };

    return response;
  }
  throw new Error(`Unable to find requestHandler for '${requestType}'`);

};

const launchRequestHandler = async (responseHelper: Clova.Context) => {
  const speak = null;
  const greeding = '';
  const userId = responseHelper.getUser().userId;
  const timestamp = new Date();

  // ユーザの郵便番号を取得
  // 見つからない場合は郵便番号を入力してもらうようにメッセージを返す
  let postalCode, postalCodeData;
  const params = {
    TableName: POSTALCODE_TABLE,
    Key: {
      id: userId,
    },
  };
  try {
    postalCodeData = await getPostalCode(params);
  } catch (err) {
    throw err;
  }

  if (!postalCodeData) {
    // 初回起動
    // あいさつ＆郵便番号を入力するように要求
    responseHelper.setSimpleSpeech(
      Clova.SpeechBuilder.createSpeechText(MESSAGE.login.base + MESSAGE.askPostalCode.speak),
    ).setReprompt(
      Clova.SpeechBuilder.createSpeechText(MESSAGE.askPostalCode.reprompt),
    );
    responseHelper.setSessionAttributes({
      STATE: STATE.ASK_POSTALCODE_FIRST,
    });

  } else if (!postalCodeData.postalCode) {
    // 起動したことはあるが郵便番号登録がまだの人
    // 郵便番号を入力するように要求
    responseHelper.setSimpleSpeech(
      Clova.SpeechBuilder.createSpeechText(MESSAGE.askPostalCode.speak),
    ).setReprompt(
      Clova.SpeechBuilder.createSpeechText(MESSAGE.askPostalCode.reprompt),
    );
    responseHelper.setSessionAttributes({
      STATE: STATE.ASK_POSTALCODE_FIRST,
    });

  } else {
    postalCode = postalCodeData.postalCode;
    const addressInfo = `${postalCode},${COUNTRYCODE}`;
    const temperature = await getTemperatureFromExternal(addressInfo);

    // // 初回起動
    // if (!attributes.date) {
    //   attributes.date = {};
    //   greeding = MESSAGE.login.base;
    // } else {
    //   const lastUsedDate = attributes.lastUsedDate;
    //   const elapsedTimeMs = (date.getTime() - lastUsedDate);
    //   if (elapsedTimeMs > 1000 * 60 * 60 * 24 * 14) {
    //     greeding = MESSAGE.login.greed;
    //   }
    // }

    // ２回目以降の起動
    // 今の気温が記録済みかどうか判定
    try {
      const temperatureSearchResp = await isSetTemperature({
        TableName: USERTEMPERATURE_TABLE,
        KeyConditionExpression: 'id = :hkey and temperature = :rkey',
        ExpressionAttributeValues: {
          ':hkey': userId,
          ':rkey': temperature,
        },
      });

      // 未登録の気温の場合、登録してもらうように促す
      // 登録済みの場合、応答を返して終了。応答にはMessaging APIの応答も含める
      // @ts-ignore
      if (temperatureSearchResp.Count === 0 || (!temperatureSearchResp.Items[0].timestamp)) {
        responseHelper.setSessionAttributes({
          STATE: STATE.ASK_TEMPERATURE,
          postalCode,
          today: temperature,
        });
        responseHelper.setSimpleSpeech(
          Clova.SpeechBuilder.createSpeechText(util.format(MESSAGE.login.speak, '')),
        ).setReprompt(
          Clova.SpeechBuilder.createSpeechText(MESSAGE.login.reprompt),
        );

      } else {
        const item = temperatureSearchResp.Items![0];
        await createGoalResponse(responseHelper, MESSAGE.response.speak, temperature, item.result, userId, item.image);
      }
    } catch (e) {
      console.log(e);
      throw e;
    }

    // 永続化情報の保存（タイムスタンプ）
    // attributes.lastUsedDate = date.getTime();
    // handlerInput.attributesManager.setPersistentAttributes(attributes);
    // await handlerInput.attributesManager.savePersistentAttributes();
  }
};

/**
 *
 * @param responseHelper
 * @param messageFormat
 * @param temperature
 * @param result
 * @param userId
 * @param image
 */
const createGoalResponse = async (responseHelper: Clova.Context,
                                  messageFormat: string,
                                  temperature: number,
                                  result: string | number,
                                  userId: string,
                                  image?: string) => {
  let speak = "";
  const messages: Types.Message[] = [];
  const selectTemplate: TemplateContent = {
    type: 'buttons',
    text: `${temperature}度の時の感想を更新したい場合は下記から選択してください。`,
    actions: [
      {
        type: 'postback',
        label: RESULT.HOT,
        data: `${temperature}&${RESULT.HOT}`,
      },
      {
        type: 'postback',
        label: RESULT.COLD,
        data: `${temperature}&${RESULT.COLD}`,
      },
      {
        type: 'postback',
        label: RESULT.GOOD,
        data: `${temperature}&${RESULT.GOOD}`,
      },
    ],
  };

  if (image) {
    messages.push({
      type: 'image',
      // originalContentUrl: `${process.env.S3_PATH}/${item.image}`,
      // previewImageUrl: "https://example.com/preview.jpg",
      originalContentUrl: `${process.env.S3_PATH}/sample.jpg`,
      previewImageUrl: `${process.env.S3_PATH}/sample-preview.jpg`,
    });
    speak = util.format(messageFormat, temperature, result, MESSAGE.image.exist);
    messages.push({
        type: 'template',
        altText: `${temperature}度の時の感想を更新したい場合は下記から選択してください。`,
        template: selectTemplate,
      }
    );
  } else {
    speak = util.format(messageFormat, temperature, result, MESSAGE.image.notExist);
    messages.push({
        type: 'template',
        altText: `${temperature}度の時の感想を更新したい場合は下記から選択してください。`,
        quickReply,
        template: selectTemplate,
      }
    );
  }

  responseHelper
    .setSimpleSpeech(Clova.SpeechBuilder.createSpeechText(speak))
    .endSession();

  messages.push();

  await lineClient.pushMessage(userId, messages);
};

/**
 *
 * @param responseHelper
 */
const inputTemperature = async (responseHelper: Clova.Context) => {
  const userId = responseHelper.getUser().userId;
  const sessionAttributes: any = responseHelper.getSessionAttributes();
  let temperature = sessionAttributes.today;
  const postalCode = sessionAttributes.postalCode;

  // 温度情報がない場合はAPIで取得し直す
  if (!temperature) {
    const addressInfo = `${postalCode},${COUNTRYCODE}`;
    temperature = getTemperatureFromExternal(addressInfo);
  }

  // スロットから気温に対する感想を取得
  const result = responseHelper.getSlot('TempType');
  const timestamp = new Date();
  if (result) {
    // 気温感想情報更新パラメータ
    const updateParams = {
      TableName: USERTEMPERATURE_TABLE,
      Key: {
        id: userId,
        temperature: parseInt(temperature),
      },
      AttributeUpdates: {
        result: {
          Action: 'PUT',
          Value: result,
        },
        timestamp: {
          Action: 'PUT',
          Value: `${timestamp.toLocaleDateString('ja')} ${timestamp.toLocaleTimeString('ja')}`,
        },
      },
    };

    try {
      // 気温の感想情報を登録
      await updateRecord(updateParams);
    } catch (err) {
      throw err;
    }

    await createGoalResponse(responseHelper, MESSAGE.input.speak, temperature, result, userId);

    // // 永続化情報の保存
    // handlerInput.attributesManager.setPersistentAttributes(attributes);
    // await handlerInput.attributesManager.savePersistentAttributes();
  } else {
    responseHelper
      .setSimpleSpeech(
        Clova.SpeechBuilder.createSpeechText(MESSAGE.error.speak),
      ).setReprompt(Clova.SpeechBuilder.createSpeechText(MESSAGE.error.reprompt),
    );
  }
};

/**
 *
 * @param addressInfo
 */
const getTemperatureFromExternal = async (addressInfo: string): Promise<number> => {
  try {
    // 登録位置情報から天気情報を取得
    const url = `/data/2.5/weather?units=metric&zip=${addressInfo}&APPID=${process.env.WEATHER_APIKEY}`;
    const weather = await axios.get(url, config);
    return Math.floor(weather.data.main.temp);
  } catch (err) {
    throw err;
  }
};

/**
 *
 * @param responseHelper
 */
const inputPostalCode = async (responseHelper: Clova.Context) => {
  const pCode = responseHelper.getSlots();
  console.log(pCode);
  let postalCode = `${pCode.SerialOne}${pCode.SerialTwo}${pCode.SerialThree}`;
  console.log(postalCode);
  if (postalCode.length == 3 && postalCode.match(/[0-9]{3}/)) {
    let speak = util.format(MESSAGE.askPostalCodeRest.speak,
      pCode.SerialOne, pCode.SerialTwo, pCode.SerialThree);
    responseHelper.setSimpleSpeech(
      Clova.SpeechBuilder.createSpeechText(speak),
    ).setReprompt(
      Clova.SpeechBuilder.createSpeechText(MESSAGE.askPostalCode.reprompt),
    );
    responseHelper.setSessionAttributes({
      STATE: STATE.ASK_POSTALCODE_REST,
      postalCodeFirst: postalCode
    });
  } else {
    responseHelper.setSimpleSpeech(
      Clova.SpeechBuilder.createSpeechText(MESSAGE.askPostalCode.error),
    ).setReprompt(
      Clova.SpeechBuilder.createSpeechText(MESSAGE.askPostalCode.error),
    );
    responseHelper.setSessionAttributes({
      STATE: STATE.ASK_POSTALCODE_FIRST,
    });
  }
};

  /**
 *
 * @param responseHelper
 */
const inputPostalCodeRest = async (responseHelper: Clova.Context) => {
  const pCode = responseHelper.getSlots();
  let postalCode = `${pCode.SerialFour}${pCode.SerialFive}${pCode.SerialSix}${pCode.SerialSeven}`;
  const sessionAttributes: any = responseHelper.getSessionAttributes();

  if (postalCode.length == 4 && postalCode.match(/[0-9]{4}/)) {
    postalCode = `${sessionAttributes.postalCodeFirst}-${postalCode}`;
  } else {
    responseHelper.setSimpleSpeech(
      Clova.SpeechBuilder.createSpeechText(MESSAGE.askPostalCodeRest.error),
    ).setReprompt(
      Clova.SpeechBuilder.createSpeechText(MESSAGE.askPostalCodeRest.error),
    );
    responseHelper.setSessionAttributes({
      STATE: STATE.ASK_POSTALCODE_REST,
      postalCodeFirst: sessionAttributes.postalCodeFirst
    });
    return;
  }

  const id = responseHelper.getUser().userId;
  const timestamp = new Date();
  const params = {
    TableName: POSTALCODE_TABLE,
    Item: {
      id,
      postalCode,
      timestamp: `${timestamp.toLocaleDateString('ja')} ${timestamp.toLocaleTimeString('ja')}`,
    },
  };
  // 郵便番号を登録
  try {
    await insertRecord(params);
  } catch (err) {
    throw err;
  }

  console.log('weather');
  const addressInfo = `${postalCode},${COUNTRYCODE}`;
  const temperature = await getTemperatureFromExternal(addressInfo);
  console.log('resp');
  responseHelper.setSessionAttributes({
    STATE: STATE.ASK_TEMPERATURE,
    postalCode,
    today: temperature,
  });

  const speak = util.format(MESSAGE.login.postalCode, postalCode)
    + util.format(MESSAGE.login.speak, '');
  responseHelper.setSimpleSpeech(
    Clova.SpeechBuilder.createSpeechText(speak),
  ).setReprompt(
    Clova.SpeechBuilder.createSpeechText(MESSAGE.login.reprompt),
  );
};

/**
 *
 * @param params
 */
const getPostalCode = async (params: DocumentClient.GetItemInput): Promise<any> => {
  try {
    const data = await documentClient.get(params).promise();
    console.log(data);
    return data.Item;
  } catch (err) {
    console.log('Error', err);
    throw err;
  }
};

/**
 *
 * @param params
 */
const insertRecord = async (params: DocumentClient.PutItemInput): Promise<boolean> => {
  try {
    await documentClient.put(params).promise();
    return true;
  } catch (err) {
    console.log('[Error] insertRecord', err);
    throw err;
  }
};

/**
 *
 * @param params
 */
const updateRecord = async (params: DocumentClient.UpdateItemInput): Promise<DocumentClient.UpdateItemOutput> => {
  try {
    return await documentClient.update(params).promise();
  } catch (err) {
    console.log('[Error] updateRecord', err);
    throw err;
  }
};

/**
 *
 * @param params
 */
const isSetTemperature = async (params: DocumentClient.QueryInput): Promise<DocumentClient.QueryOutput> => {
  try {
    const data = await documentClient.query(params).promise();
    console.log(data);
    return data;
  } catch (err) {
    console.log('[Error] isSetTemperature ', err);
    throw err;
  }
};

/**
 *
 */
const clovaSkillHandler = Clova.Client
  .configureSkill()
  .onLaunchRequest(launchRequestHandler)
  .onIntentRequest(async (responseHelper: Clova.Context) => {
    const intent = responseHelper.getIntentName();
    const sessionId = responseHelper.getSessionId();
    const sessionAttributes: any = responseHelper.getSessionAttributes();

    switch (intent) {
      case 'Clova.CancelIntent':
        responseHelper.setSimpleSpeech(
          Clova.SpeechBuilder.createSpeechText(MESSAGE.exit.speak),
        ).endSession();
        break;
      case 'Clova.GuideIntent':
        if (sessionAttributes.STATE === STATE.ASK_POSTALCODE_FIRST) {
          responseHelper.setSimpleSpeech(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.help.askPostalCode),
          ).setReprompt(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.askPostalCode.reprompt),
          );
        } else if (sessionAttributes.STATE === STATE.ASK_POSTALCODE_REST) {
          responseHelper.setSimpleSpeech(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.help.askPostalCodeRest),
          ).setReprompt(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.askPostalCodeRest.reprompt),
          );
        } else if (sessionAttributes.STATE === STATE.ASK_TEMPERATURE) {
          responseHelper.setSimpleSpeech(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.help.input),
          ).setReprompt(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.help.reprompt),
          );
        } else {
          responseHelper.setSimpleSpeech(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.help.login),
          ).endSession();
        }
        break;
      case 'InputIntent':
        await inputTemperature(responseHelper);
        break;
      case 'PostalCodeIntent':
        console.log("postalcodeintent", JSON.stringify(sessionAttributes, null, 2));
        if (sessionAttributes.STATE === STATE.ASK_POSTALCODE_FIRST) {
          await inputPostalCode(responseHelper);
        } else if (sessionAttributes.STATE === STATE.ASK_POSTALCODE_REST) {
          // はじめの三桁ではなく四桁をようきゅうする
          responseHelper.setSimpleSpeech(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.error.restPostalCode),
          ).setReprompt(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.error.restPostalCode),
          );
        } else {
          responseHelper.setSimpleSpeech(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.error.speak),
          ).setReprompt(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.error.reprompt),
          );
        }
        break;
      case 'PostalCodeRestIntent':
        console.log("postalcoderestintent", JSON.stringify(sessionAttributes, null, 2));
        if (sessionAttributes.STATE === STATE.ASK_POSTALCODE_REST) {
          await inputPostalCodeRest(responseHelper);
        } else if (sessionAttributes.STATE === STATE.ASK_POSTALCODE_FIRST) {
          // 4桁ではなく3桁をようきゅうする
          responseHelper.setSimpleSpeech(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.error.firstPostalCode),
          ).setReprompt(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.error.firstPostalCode),
          );
        } else {
          responseHelper.setSimpleSpeech(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.error.speak),
          ).setReprompt(
            Clova.SpeechBuilder.createSpeechText(MESSAGE.error.reprompt),
          );
        }
        break;
      default:
        responseHelper.setSimpleSpeech(
          Clova.SpeechBuilder.createSpeechText(MESSAGE.error.speak),
        ).setReprompt(
          Clova.SpeechBuilder.createSpeechText(MESSAGE.error.reprompt),
        );
        break;
    }
  })
  .onSessionEndedRequest((responseHelper: Clova.Context) => {
    // Do something on session end
  });
