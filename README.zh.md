# 注册QQ开放平台
前往腾讯QQ开放平台官网，默认无法使用您的QQ账号直接登录，需要新注册QQ开放平台账号。
<img width="2140" height="1004" alt="1" src="https://github.com/user-attachments/assets/d76a780c-5040-43fb-ac41-5808f975ae4b" />

首次注册之后，可以按照QQ开放平台的指引设置超级管理员。

<img width="2556" height="1744" alt="2" src="https://github.com/user-attachments/assets/ad0a54d5-6997-4f52-ae8f-bea71aa11c30" />
手机QQ扫码成功后，继续下一步填写主体相关信息。

此处以“个人”为例，按照指引依次输入姓名、身份证号、手机号、验证码，点击继续进入下一步人脸认证。
<img width="2544" height="1744" alt="3" src="https://github.com/user-attachments/assets/b85c11f8-5627-4e08-b522-b38c4929bcb6" />

使用手机QQ扫码进行人脸认证。
<img width="2542" height="1272" alt="4" src="https://github.com/user-attachments/assets/d0db5539-56ef-4189-930f-595348892bef" />

人脸识别审核通过后，即可登录进入QQ开放平台。
<img width="2356" height="1308" alt="5" src="https://github.com/user-attachments/assets/c1875b27-fefc-4a1c-81ef-863da8b15ec6" />

# 创建一个QQBot机器人
在QQ开放平台的QQ机器人页面，可以创建机器人。
<img width="2334" height="1274" alt="6" src="https://github.com/user-attachments/assets/8389c38d-6662-46d0-ae04-92af374b61ef" />
<img width="2316" height="1258" alt="7" src="https://github.com/user-attachments/assets/15cfe57a-0404-4b02-85fe-42a22cf96d01" />

QQ机器人创建完成之后，可选择机器人点击进入管理页面。
<img width="3002" height="1536" alt="8" src="https://github.com/user-attachments/assets/7c0c7c69-29db-457f-974a-4aa52ebd7973" />

在QQ机器人管理页面获取当前机器人的AppID和AppSecret，复制并将其保存到个人记事本或备忘录中（请注意数据安全，勿泄露），后续在“为OpenClaw配置QQ机器人AppID和AppSecret”步骤中需要使用。

注意：出于安全考虑，QQ机器人的AppSecret不支持明文保存，首次查看或忘记AppSecret需要重新生成。
<img width="2970" height="1562" alt="9" src="https://github.com/user-attachments/assets/c7fc3094-2840-4780-a202-47b2c2b74e50" />
<img width="1258" height="594" alt="10" src="https://github.com/user-attachments/assets/4445bede-e7d5-4927-9821-039e7ad8f1f5" />

# 沙箱配置
在QQ机器人的“开发管理”页面，在“沙箱配置”中，设置单独聊天（选择“在消息列表配置”）。

您可以按照自己的使用场景进行配置，也可以完成后续步骤之后再回到本步骤进行操作。

⚠️ 注意：
此处已创建的QQ机器人无需进行发布上架对所有QQ用户公开使用，在开发者私人的（沙箱）调试下使用体验即可。
QQ开放平台不支持机器人的“在QQ群配置”操作，只支持单独和QQ机器人聊天。
<img width="1904" height="801" alt="11" src="https://github.com/user-attachments/assets/f3940a87-aae7-4c89-8f9a-c94fb52cd3ea" />

注意：选择“在消息列表配置”时，需要先添加成员，再通过该成员的QQ扫码来添加机器人。
<img width="2582" height="484" alt="12" src="https://github.com/user-attachments/assets/5631fe76-2205-4f1e-b463-75fa3a397464" />
此处注意添加成员成功之后，还需要使用QQ扫码添加

<img width="2286" height="1324" alt="13" src="https://github.com/user-attachments/assets/cbf379be-ef6e-4391-8cb1-67c08aad2d43" />
此时您的QQ账号添加机器人之后，还不能与该机器人正常进行对话，会提示“该机器人去火星了，稍后再试吧”，因为QQ机器人此时尚未与OpenClaw应用打通。

您需要继续后面的步骤，为OpenClaw应用配置QQ机器人的AppID和AppSecret。

<img width="872" height="1052" alt="14" src="https://github.com/user-attachments/assets/0c02aaf6-6cf9-419c-a6ab-36398d73c5ba" />

（可选）您也可以参考前述步骤添加更多成员：首先在成员管理页面中添加新成员，然后在沙箱配置页面中添加成员，之后新成员即可通过QQ扫码添加该QQ机器人。
<img width="3006" height="1504" alt="15" src="https://github.com/user-attachments/assets/cecef3a6-0596-4da0-8b92-8d67b8f3cdca" />
<img width="2902" height="1394" alt="16" src="https://github.com/user-attachments/assets/eb98ffce-490f-402c-8b0c-af7ede1b1303" />
<img width="1306" height="672" alt="17" src="https://github.com/user-attachments/assets/799056e3-82a6-44bc-9e3d-9c840faafa41" />
