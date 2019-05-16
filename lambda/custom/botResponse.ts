import { QuickReply } from '@line/bot-sdk/lib/types';

// camera系アクションが定義ファイルにないので無視する
// @ts-ignore
export const quickReply: QuickReply = {
  items: [
    {
      type: 'action',
      action: {
        type: 'cameraRoll',
        label: 'フォト',
      },
    },
    {
      type: 'action',
      action: {
        type: 'camera',
        label: 'カメラ起動',
      },
    },
  ],
};
