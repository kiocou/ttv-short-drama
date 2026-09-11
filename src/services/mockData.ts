import { SeriesItem, ChannelType } from '../types/catalog';
import { SeriesDetail, EpisodeItem } from '../types/series';
import { WatchHistoryItem } from '../types/history';

// 公共流媒体测试视频源（高质量、低延迟、多格式兼容）
const SAMPLE_VIDEOS = [
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyBlazes.mp4",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4"
];

export const MOCK_SERIES_LIST: SeriesItem[] = [
  {
    id: 'drama-001',
    title: '龙王出狱：镇世无双',
    cover: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=600&auto=format&fit=crop&q=80',
    backdrop: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=1600&auto=format&fit=crop&q=80',
    type: 'drama',
    episodesCount: 80,
    latestEpisodeTitle: '第80集 终极对决，九洲尊主',
    tags: ['战神归来', '逆袭', '都市修真', '爽文'],
    origin: '短剧官仓直链',
    rating: 9.8,
    heat: 998000,
    updateTime: '今天 18:30',
    brief: '三年前，他替豪门背锅入狱，深狱之中拜得医道圣手与武道至尊。三年后王者归来，未婚妻竟已悔婚别嫁……'
  },
  {
    id: 'drama-002',
    title: '重回1998：首富从摆摊开始',
    cover: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=600&auto=format&fit=crop&q=80',
    backdrop: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1600&auto=format&fit=crop&q=80',
    type: 'drama',
    episodesCount: 96,
    latestEpisodeTitle: '第96集 登顶全球福布斯',
    tags: ['重生逆袭', '商战', '年代爆款', '暴富'],
    origin: 'App急速通道',
    rating: 9.6,
    heat: 885000,
    updateTime: '今天 12:00',
    brief: '身价千亿的商界巨鳄意外重生回到1998年窘迫的下岗小家庭。这一世，他要挽回所有遗憾，打造属于自己的商业帝国！'
  },
  {
    id: 'drama-003',
    title: '顾总，夫人才是隐藏财阀继承人',
    cover: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=600&auto=format&fit=crop&q=80',
    backdrop: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=1600&auto=format&fit=crop&q=80',
    type: 'drama',
    episodesCount: 68,
    latestEpisodeTitle: '第68集 世纪盛婚，全城俯首',
    tags: ['豪门甜宠', '马甲打脸', '女频爆款', '先婚后爱'],
    origin: '短剧官仓直链',
    rating: 9.7,
    heat: 942000,
    updateTime: '昨天 21:00',
    brief: '结婚三年，所有人都以为她只是个攀附权贵的家庭主妇。直到千亿财阀全球寻回继承人发布会上，她踩着十公分高跟鞋走上主席台……'
  },
  {
    id: 'drama-004',
    title: '大秦：祖龙偷听我心声，杀疯了',
    cover: 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=600&auto=format&fit=crop&q=80',
    backdrop: 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=1600&auto=format&fit=crop&q=80',
    type: 'drama',
    episodesCount: 100,
    latestEpisodeTitle: '第100集 大秦铁骑，踏平寰宇',
    tags: ['历史脑洞', '穿越', '爽剧', '群像'],
    origin: '备用解析源A',
    rating: 9.9,
    heat: 1240000,
    updateTime: '今天 16:40',
    brief: '穿越成大秦九公子，本想做个混吃等死的纨绔，没想到始皇帝竟能偷听我的心声！“父皇，徐福那是带毒的汞丹啊……”'
  },
  {
    id: 'drama-005',
    title: '替嫁千金是满级玄学大佬',
    cover: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=600&auto=format&fit=crop&q=80',
    backdrop: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=1600&auto=format&fit=crop&q=80',
    type: 'drama',
    episodesCount: 72,
    latestEpisodeTitle: '第72集 破局渡劫，天道归一',
    tags: ['玄学天师', '打脸', '甜宠', '爽文'],
    origin: '短剧官仓直链',
    rating: 9.5,
    heat: 760000,
    updateTime: '2天前',
    brief: '从小在道观长大的真千金被接回替假千金出嫁冲喜。植物人首富老公当晚就苏醒，商界大佬更是排队求一张平安符……'
  },
  {
    id: 'comic-001',
    title: '开局签到至尊圣体',
    cover: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600&auto=format&fit=crop&q=80',
    backdrop: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1600&auto=format&fit=crop&q=80',
    type: 'comic',
    episodesCount: 120,
    latestEpisodeTitle: '第120话 踏灭禁区，万古独尊',
    tags: ['玄幻修真', '动态漫', '系统签到', '无敌流'],
    origin: '漫剧专属高码源',
    rating: 9.7,
    heat: 1100000,
    updateTime: '今天 14:00',
    brief: '穿越玄幻大世界，成为荒古世家神子。开局签到大成荒古圣体，异象震动九天十地！'
  },
  {
    id: 'comic-002',
    title: '我独自升级：暗影君王降临',
    cover: 'https://images.unsplash.com/photo-1563089145-599997674d42?w=600&auto=format&fit=crop&q=80',
    backdrop: 'https://images.unsplash.com/photo-1563089145-599997674d42?w=1600&auto=format&fit=crop&q=80',
    type: 'comic',
    episodesCount: 88,
    latestEpisodeTitle: '第88话 站起来！千军万马归位',
    tags: ['热血冒险', '异能觉醒', '动作打斗', '动态漫'],
    origin: '漫剧专属高码源',
    rating: 9.9,
    heat: 1890000,
    updateTime: '今天 10:30',
    brief: '从最弱的E级猎人，到觉醒暗影召唤能力的唯一升级者。在怪物横行的地下城中，他让死亡为他效命！'
  },
  {
    id: 'comic-003',
    title: '修真聊天群：前辈们带带我',
    cover: 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&auto=format&fit=crop&q=80',
    backdrop: 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=1600&auto=format&fit=crop&q=80',
    type: 'comic',
    episodesCount: 95,
    latestEpisodeTitle: '第95话 宋书航的拖拉机大赛',
    tags: ['搞笑修仙', '现代修真', '动态漫', '脑洞'],
    origin: '官网直链',
    rating: 9.6,
    heat: 650000,
    updateTime: '3天前',
    brief: '某天宋书航意外加入了一个中二病满满的聊天群，群里全是以“道友”、“仙子”互称的群友。直到他按群里的药方煮出淬体丹……'
  }
];

export function generateEpisodesForSeries(seriesId: string, count: number): EpisodeItem[] {
  const episodes: EpisodeItem[] = [];
  for (let i = 1; i <= count; i++) {
    const videoUrl = SAMPLE_VIDEOS[(i - 1) % SAMPLE_VIDEOS.length];
    episodes.push({
      id: `${seriesId}-ep-${i}`,
      seriesId,
      episodeNumber: i,
      title: `第 ${i} 集 ${i === 1 ? '开局惊艳' : i === count ? '高能终局' : '反转升级'}`,
      durationSeconds: 150 + ((i * 17) % 60), // 约2.5~3.5分钟
      videoUrl,
      watchedSeconds: i === 1 ? 120 : i === 2 ? 45 : 0,
      isFinished: i === 1,
    });
  }
  return episodes;
}

export function getSeriesDetail(seriesId: string): SeriesDetail | null {
  const item = MOCK_SERIES_LIST.find(s => s.id === seriesId) || MOCK_SERIES_LIST[0];
  if (!item) return null;

  return {
    ...item,
    description: item.brief || '高燃快节奏短剧，扣人心弦的情节与极致反转。',
    episodes: generateEpisodesForSeries(item.id, item.episodesCount),
    availableQualities: [
      { label: '4K 杜比臻彩', value: '4k', resolution: '3840x2160', bitrate: '16 Mbps' },
      { label: '1080P 超清', value: '1080p', resolution: '1920x1080', bitrate: '6 Mbps' },
      { label: '720P 高清', value: '720p', resolution: '1280x720', bitrate: '2.5 Mbps' },
      { label: '自动适应', value: 'auto', resolution: '自适应', bitrate: '智能档' }
    ],
    sources: [
      { id: 'src-1', name: '官仓超高速直链 (首选)', isPrimary: true, health: 'healthy', pingMs: 24 },
      { id: 'src-2', name: '云端备用高码集群', isPrimary: false, health: 'healthy', pingMs: 42 },
      { id: 'src-3', name: 'P2P 极速加速网', isPrimary: false, health: 'degraded', pingMs: 110 }
    ]
  };
}

export const INITIAL_WATCH_HISTORY: WatchHistoryItem[] = [
  {
    seriesId: 'drama-001',
    episodeId: 'drama-001-ep-1',
    title: '龙王出狱：镇世无双',
    seriesCover: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=600&auto=format&fit=crop&q=80',
    episodeNumber: 1,
    totalEpisodes: 80,
    positionSeconds: 118,
    durationSeconds: 160,
    progressPercent: 74,
    updatedAt: Date.now() - 3600 * 1000 * 2, // 2小时前
    isFinished: false
  },
  {
    seriesId: 'drama-002',
    episodeId: 'drama-002-ep-3',
    title: '重回1998：首富从摆摊开始',
    seriesCover: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=600&auto=format&fit=crop&q=80',
    episodeNumber: 3,
    totalEpisodes: 96,
    positionSeconds: 85,
    durationSeconds: 175,
    progressPercent: 48,
    updatedAt: Date.now() - 3600 * 1000 * 18, // 18小时前
    isFinished: false
  }
];
